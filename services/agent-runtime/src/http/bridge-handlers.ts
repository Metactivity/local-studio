// The Browser Bridge's HTTP surface (MET-921): the JSON-RPC endpoint the
// `chrome_*` tools post to, and the pairing/status routes the panel card uses.

import { JSON_RPC_INVALID_REQUEST, rpcFailure } from "@metactivity/protocol";
import { browserBridge, DEFAULT_SESSION } from "../browser-bridge/relay";
import { jsonError, readJsonBody } from "./helpers";

const MAX_RPC_CHARS = 1024 * 1024;

const sessionOf = (value: string | null | undefined): string => value?.trim() || DEFAULT_SESSION;

/** Where the extension should dial: the runtime's own loopback base unless the operator names a public one. */
export function bridgeStationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LOCAL_STUDIO_BRIDGE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8081;
  return `http://127.0.0.1:${port}`;
}

export async function handleBridgeRpc(request: Request): Promise<Response> {
  const expected = process.env.LOCAL_STUDIO_BRIDGE_TOKEN?.trim();
  if (expected && request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json(rpcFailure(null, JSON_RPC_INVALID_REQUEST, "unauthorized"), { status: 401 });
  }
  const sessionId = sessionOf(request.headers.get("x-tuum-session") ?? request.headers.get("x-sitegeist-session"));
  const body = await readJsonBody(request, { maxChars: MAX_RPC_CHARS });
  if (!body || body.jsonrpc !== "2.0") {
    return Response.json(rpcFailure(null, JSON_RPC_INVALID_REQUEST, "expected a JSON-RPC 2.0 request"), { status: 400 });
  }
  const id = typeof body.id === "number" || typeof body.id === "string" ? body.id : null;
  return Response.json(await browserBridge().rpc(sessionId, id, body.method, body.params));
}

export function handleBridgeStatus(request: Request): Response {
  const sessionId = sessionOf(new URL(request.url).searchParams.get("sessionId"));
  return Response.json({ ...browserBridge().status(sessionId), stationUrl: bridgeStationUrl() });
}

export async function handleBridgePairStart(request: Request): Promise<Response> {
  const body = (await readJsonBody(request, { maxChars: 4096 })) ?? {};
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") return jsonError("sessionId must be a string");
  const sessionId = sessionOf(body.sessionId as string | undefined);
  return Response.json({ sessionId, ...browserBridge().startPairing(sessionId), stationUrl: bridgeStationUrl() });
}
