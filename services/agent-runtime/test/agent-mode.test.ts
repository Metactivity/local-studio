import { describe, expect, test } from "bun:test";
import {
  agentModeFromPath,
  agentWorkspaceHref,
  readAgentMode,
  resolveAgentMode,
  writeAgentMode,
} from "../../../shared/agent/agent-mode";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) };
};

describe("agent mode (MET-934)", () => {
  test("remembers the mode per project and tolerates a throwing storage", () => {
    const storage = memory();
    expect(readAgentMode(storage, "p1")).toBeNull();
    writeAgentMode(storage, "p1", "ide");
    expect(readAgentMode(storage, "p1")).toBe("ide");
    expect(readAgentMode(storage, "p2")).toBeNull();
    storage.setItem("local-studio.agentMode.p2", "garbage");
    expect(readAgentMode(storage, "p2")).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => writeAgentMode(broken, "p1", "chat")).not.toThrow();
    expect(readAgentMode(broken, "p1")).toBeNull();
    expect(readAgentMode(null, "p1")).toBeNull();
  });

  test("a bare route is explicit, a deep link reopens in the remembered mode", () => {
    expect(resolveAgentMode("chat", "", "ide")).toBe("chat");
    expect(resolveAgentMode("ide", "", "chat")).toBe("ide");
    expect(resolveAgentMode("chat", "project=p1&session=s", "ide")).toBe("ide");
    expect(resolveAgentMode("chat", "new=1", null)).toBe("chat");
  });

  test("routes and hrefs", () => {
    expect(agentModeFromPath("/ide")).toBe("ide");
    expect(agentModeFromPath("/chat")).toBe("chat");
    expect(agentModeFromPath("/agent/automations")).toBeNull();
    expect(agentWorkspaceHref("p 1", { session: "s/1" })).toBe(
      "/chat?project=p+1&session=s%2F1&replace=1",
    );
    expect(agentWorkspaceHref("p1", { new: true })).toBe("/chat?project=p1&new=1&replace=1");
    expect(agentWorkspaceHref("p1")).toBe("/chat?project=p1&replace=1");
  });

  test("/agent redirects to the chat landing", async () => {
    const config = (await import("../../../frontend/next.config")).default;
    expect(await config.redirects!()).toEqual([
      { source: "/agent", destination: "/chat", permanent: false },
    ]);
  });
});
