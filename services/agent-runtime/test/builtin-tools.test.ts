// The built-in harness tools (MET-915 W4): the inventory per enable gate, one
// smoke call per module against fakes, and the two policies.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, type HarnessTool, type ToolContext, withAgentPolicy, withTimeoutPolicy } from "../src/tools";
import { bashTimeoutFor } from "../src/tools/policies";

type Route = (path: string, init?: RequestInit) => unknown;

const GATES_OFF = { browser: false, chrome: false, github: false, obsidian: false, connectors: false };

/** A ToolContext whose runtime is a table of path → JSON reply, recording every request. */
function context(routes: Record<string, Route>, overrides: Partial<ToolContext> = {}) {
  const seen: Array<{ path: string; init?: RequestInit }> = [];
  const ctx: ToolContext = {
    cwd: "/tmp/project",
    sessionId: "sess-1",
    modelId: "fake-model",
    env: { LOCAL_STUDIO_CWD: "/tmp/project" },
    gates: GATES_OFF,
    request: async (path, init) => {
      seen.push({ path, init });
      const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1];
      if (!route) return Response.json({ error: `no route for ${path}` }, { status: 404 });
      return Response.json(route(path, init));
    },
    ...overrides,
  };
  return { ctx, seen };
}

const names = (tools: HarnessTool[]) => tools.map((tool) => tool.name);
const byName = (tools: HarnessTool[], name: string) => tools.find((tool) => tool.name === name)!;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]!.text!;

const ALWAYS = [
  "subagent",
  "subagent_list",
  "subagent_status",
  "subagent_stop",
  "list_automations",
  "read_automation",
  "schedule_automation",
  "update_automation",
  "set_automation_status",
  "run_automation_now",
  "delete_automation",
];

function fakeRelay(methods: string[]) {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { method: string; id: number };
      const result = body.method === "relay.capabilities" ? { methods } : { url: "https://example.com", title: "Example" };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("builtinTools per enable gate", () => {
  test("nothing armed: subagents and automations only", async () => {
    const { ctx } = context({});
    expect(names(await builtinTools(ctx))).toEqual(ALWAYS);
  });

  test("browser on with the embedded backend: browser_* without chrome_*", async () => {
    const { ctx } = context({}, { gates: { ...GATES_OFF, browser: true } });
    const tools = names(await builtinTools(ctx));
    expect(tools.filter((name) => name.startsWith("browser_"))).toHaveLength(12);
    expect(tools.some((name) => name.startsWith("chrome_"))).toBe(false);
  });

  test("chrome armed: chrome_* only for the methods a reachable relay advertises", async () => {
    const gates = { ...GATES_OFF, browser: true, chrome: true };
    const unreachable = context({}, { gates, env: { LOCAL_STUDIO_CHROME_RELAY_URL: "http://127.0.0.1:1" } });
    expect(names(await builtinTools(unreachable.ctx)).some((name) => name.startsWith("chrome_"))).toBe(false);

    const relay = fakeRelay(["browser.url"]);
    try {
      const { ctx } = context({}, { gates, env: { LOCAL_STUDIO_CHROME_RELAY_URL: relay.url } });
      const tools = await builtinTools(ctx);
      expect(names(tools).filter((name) => name.startsWith("chrome_"))).toEqual(["chrome_get_url", "chrome_history"]);
      const result = await byName(tools, "chrome_get_url").execute("c1", {});
      expect(JSON.parse(text(result))).toEqual({ url: "https://example.com", title: "Example" });
    } finally {
      relay.stop();
    }
  });

  test("github, obsidian and connectors gates add their families", async () => {
    const { ctx } = context(
      {
        "/api/agent/connectors/call": () => ({
          connectors: [{ id: "my-conn", name: "My Conn", tools: [{ name: "do.thing", description: "Does it", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }],
        }),
      },
      { gates: { ...GATES_OFF, github: true, obsidian: true, connectors: true } },
    );
    const tools = names(await builtinTools(ctx));
    expect(tools.filter((name) => name.startsWith("github_"))).toHaveLength(12);
    expect(tools.filter((name) => name.startsWith("obsidian_"))).toHaveLength(7);
    expect(tools).toContain("my_conn_do_thing");
  });
});

describe("one smoke call per module", () => {
  test("automations: list reads the runtime store; a bad schedule fails before any call", async () => {
    const { ctx, seen } = context({ "/api/agent/automations": () => ({ automations: [] }) });
    const tools = await builtinTools(ctx);
    const listed = await byName(tools, "list_automations").execute("c1", {});
    expect(text(listed)).toBe("No automations are scheduled. Use schedule_automation to create one.");
    expect(seen.map((request) => request.path)).toEqual(["/api/agent/automations"]);

    const bad = await byName(tools, "schedule_automation").execute("c2", { prompt: "hi", schedule: { kind: "daily", time: "25:00" } });
    expect(text(bad)).toBe("daily schedule needs 'time' as 'HH:MM' (24h).");
    expect(bad.details).toMatchObject({ failed: true });
    const schema = byName(tools, "schedule_automation").parameters as { type: string; required: string[] };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["prompt", "schedule"]);
  });

  test("subagents: management routes carry this session's id", async () => {
    const { ctx, seen } = context({ "/api/agent/subagents": () => ({ subagents: [] }) });
    const result = await byName(await builtinTools(ctx), "subagent_list").execute("c1", {});
    expect(text(result)).toBe("This session has not spawned any subagents.");
    expect(seen[0]!.path).toBe("/api/agent/subagents?piSessionId=sess-1");
  });

  test("cua: browser_* posts to the browser host with the session's browser id", async () => {
    const { ctx, seen } = context(
      { "/api/agent/browser/get-url": () => ({ ok: true, data: { url: "https://a.test/", title: "A" } }) },
      { gates: { ...GATES_OFF, browser: true }, env: { LOCAL_STUDIO_BROWSER_SESSION_ID: "b-9" } },
    );
    const result = await byName(await builtinTools(ctx), "browser_get_url").execute("c1", {});
    expect(JSON.parse(text(result))).toEqual({ url: "https://a.test/", title: "A" });
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ sessionId: "b-9" });
  });

  test("github: credential subcommands are refused; a missing gh reports the same text pi did", async () => {
    const { ctx } = context({}, { gates: { ...GATES_OFF, github: true }, env: { LOCAL_STUDIO_GH_PATH: "/nonexistent/gh", LOCAL_STUDIO_CWD: "/tmp" } });
    const tools = await builtinTools(ctx);
    const refused = await byName(tools, "github_cli").execute("c1", { args: ["auth", "status"] });
    expect(text(refused)).toStartWith("github_cli refuses `gh auth`");
    expect(refused.details).toMatchObject({ refused: true, failed: true });
    const status = await byName(tools, "github_status").execute("c2", {});
    expect(text(status)).toContain("Session directory: /tmp");
    expect(text(status)).toContain("No GitHub repository resolved from /tmp");
  });

  test("obsidian: reads the injected vault, resolves wikilinks, never overwrites", async () => {
    const vault = realpathSync(mkdtempSync(join(tmpdir(), "vault-")));
    mkdirSync(join(vault, "Projects"));
    writeFileSync(join(vault, "Projects", "Roadmap.md"), "---\ntags: [plan]\n---\nSee [[Ideas|the ideas]] #q3\n");
    writeFileSync(join(vault, "Ideas.md"), "Some ideas\n");
    const vaults = JSON.stringify([{ path: vault, name: "vault", open: true, lastOpened: null }]);
    const { ctx } = context({}, { gates: { ...GATES_OFF, obsidian: true }, env: { LOCAL_STUDIO_OBSIDIAN_VAULTS: vaults } });
    const tools = await builtinTools(ctx);
    const read = JSON.parse(text(await byName(tools, "obsidian_read").execute("c1", { note: "Roadmap" })));
    expect(read).toMatchObject({ path: join("Projects", "Roadmap.md"), tags: ["plan", "q3"], links: [{ target: "Ideas", alias: "the ideas", path: "Ideas.md" }] });
    const clash = await byName(tools, "obsidian_create").execute("c2", { note: "Ideas", content: "x" });
    expect(text(clash)).toContain('"Ideas.md" already exists in vault "vault" and was NOT touched.');
    expect(clash.details).toMatchObject({ refused: true, failed: true });
  });

  test("connectors: one tool per inventory entry, schema passed through, calls rendered as text", async () => {
    const { ctx, seen } = context(
      {
        "/api/agent/connectors/call": (path, init) =>
          init?.method === "POST"
            ? { ok: true, result: { content: [{ type: "text", text: "done" }] } }
            : { connectors: [{ id: "my-conn", name: "My Conn", tools: [{ name: "do.thing", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }] },
      },
      { gates: { ...GATES_OFF, connectors: true } },
    );
    const tool = byName(await builtinTools(ctx), "my_conn_do_thing");
    expect(tool.description).toBe("do.thing via the My Conn connector");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(text(await tool.execute("c1", { q: "x" }))).toBe("done");
    expect(JSON.parse(String(seen[1]!.init?.body))).toEqual({ connector_id: "my-conn", tool: "do.thing", args: { q: "x" }, model_id: "fake-model" });
  });
});

describe("policies", () => {
  test("bash timeout: default when missing, capped when too large, env-tunable", () => {
    expect(bashTimeoutFor({}, undefined)).toBe(120);
    expect(bashTimeoutFor({}, 30)).toBe(30);
    expect(bashTimeoutFor({}, 5000)).toBe(900);
    expect(bashTimeoutFor({ LOCAL_STUDIO_BASH_TIMEOUT_SECONDS: "10", LOCAL_STUDIO_BASH_MAX_TIMEOUT_SECONDS: "20" }, 99)).toBe(20);
  });

  test("the timeout policy wraps only the bash tool", async () => {
    let received: unknown;
    const bash: HarnessTool = {
      name: "bash",
      label: "bash",
      description: "",
      parameters: {} as never,
      execute: async (_id, params) => {
        received = params;
        return { content: [], details: undefined };
      },
    };
    const read: HarnessTool = { ...bash, name: "read" };
    const [wrappedBash, wrappedRead] = withTimeoutPolicy([bash, read], {});
    expect(wrappedRead).toBe(read);
    await wrappedBash!.execute("c1", { command: "ls" });
    expect(received).toEqual({ command: "ls", timeout: 120 });
  });

  test("the artifact policy is appended once", () => {
    const once = withAgentPolicy("Base prompt.");
    expect(once).toStartWith("Base prompt.\n\nLocal Studio artifact policy:");
    expect(withAgentPolicy(once)).toBe(once);
  });
});
