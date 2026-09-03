// The provider login-job state machine over a fake ModelRuntime: events log,
// parked prompt, respond, cancel, and the list/logout guards — the surface the
// /api/agent/providers/* handlers expose, without touching a real OAuth server.

import { beforeAll, describe, expect, test } from "bun:test";
import type { AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";
import { getGlobalSingleton } from "../src/instances";
import {
  cancelProviderLogin,
  getProviderLoginJob,
  listProviders,
  logoutProvider,
  respondProviderLogin,
  startProviderLogin,
} from "../src/provider-hub";

const provider = {
  id: "fakecloud",
  name: "Fake Cloud",
  auth: { oauth: { name: "Fake OAuth" }, apiKey: { name: "API key", login: true } },
} as unknown as Provider;

const fakeRuntime = {
  getProviders: () => [provider, { id: "local-studio", name: "Local", auth: {} } as unknown as Provider],
  getProvider: (id: string) => (id === provider.id ? provider : undefined),
  getProviderAuthStatus: () => ({ configured: false }),
  getModels: () => [],
  listCredentials: async () => [],
  logout: async () => undefined,
  async login(_id: string, _type: string, interaction: AuthInteraction): Promise<Credential> {
    interaction.notify({ type: "auth_url", url: "https://fake.example/authorize" });
    const code = await interaction.prompt({ type: "input", message: "Paste the code" } as never);
    if (code !== "42") throw new Error("bad code");
    return { type: "api_key", key: "k" };
  },
};

const settled = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

beforeAll(() => {
  getGlobalSingleton("providerHubRuntime", () => Promise.resolve(fakeRuntime));
});

describe("provider hub login jobs", () => {
  test("lists the cloud providers only and rejects unknown ids", async () => {
    expect((await listProviders()).map((view) => view.id)).toEqual(["fakecloud"]);
    expect(await startProviderLogin("nope", "oauth")).toEqual({ error: "Unknown provider 'nope'.", status: 404 });
    expect(await logoutProvider("local-studio")).toEqual({ error: "Unknown provider 'local-studio'.", status: 404 });
    expect(await logoutProvider("fakecloud")).toEqual({ ok: true });
  });

  test("a login parks its prompt until the UI answers, then succeeds", async () => {
    const started = await startProviderLogin("fakecloud", "oauth");
    if ("error" in started) throw new Error(started.error);
    await settled(() => getProviderLoginJob(started.jobId)?.pendingPrompt !== undefined);
    const job = getProviderLoginJob(started.jobId)!;
    expect(job).toMatchObject({ providerId: "fakecloud", authType: "oauth", status: "running" });
    expect(job.events.map((entry) => entry.event)).toEqual([{ type: "auth_url", url: "https://fake.example/authorize" }]);
    expect(job.pendingPrompt).toMatchObject({ id: 1, type: "input", message: "Paste the code" });
    expect(getProviderLoginJob(started.jobId, 1)!.events).toEqual([]);

    expect(respondProviderLogin(started.jobId, 99, "42")).toBe(false);
    expect(respondProviderLogin(started.jobId, 1, "42")).toBe(true);
    await settled(() => getProviderLoginJob(started.jobId)?.status !== "running");
    expect(getProviderLoginJob(started.jobId)).toMatchObject({ status: "success" });
    expect(getProviderLoginJob(started.jobId)!.pendingPrompt).toBeUndefined();
  });

  test("a wrong answer fails the job; cancel ends a running one", async () => {
    const failing = await startProviderLogin("fakecloud", "api_key");
    if ("error" in failing) throw new Error(failing.error);
    await settled(() => getProviderLoginJob(failing.jobId)?.pendingPrompt !== undefined);
    respondProviderLogin(failing.jobId, 1, "wrong");
    await settled(() => getProviderLoginJob(failing.jobId)?.status !== "running");
    expect(getProviderLoginJob(failing.jobId)).toMatchObject({ status: "error", error: "bad code" });

    const cancelled = await startProviderLogin("fakecloud", "oauth");
    if ("error" in cancelled) throw new Error(cancelled.error);
    await settled(() => getProviderLoginJob(cancelled.jobId)?.pendingPrompt !== undefined);
    expect(cancelProviderLogin(cancelled.jobId)).toBe(true);
    expect(getProviderLoginJob(cancelled.jobId)).toMatchObject({ status: "cancelled" });
    expect(respondProviderLogin(cancelled.jobId, 1, "42")).toBe(false);
    expect(cancelProviderLogin("missing")).toBe(false);
  });
});
