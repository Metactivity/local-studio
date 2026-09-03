import { readRequestBytesWithinLimit } from "@shared/agent/agent-turn-body";
import { TUUM_FOLDER_HEADER, TUUM_SESSION_HEADER } from "@shared/agent/workspace-identity";

const HOP_BY_HOP_REQUEST_HEADERS = ["host", "connection", "content-length", "accept-encoding"];
const DEFAULT_AGENT_RUNTIME_URL = "http://127.0.0.1:8081";

type AgentRuntimeProxyOptions = {
  bodyLimitBytes?: number;
};

export function agentRuntimeBaseUrl(): string {
  const raw = process.env.LOCAL_STUDIO_AGENT_RUNTIME_URL?.trim();
  return (raw || DEFAULT_AGENT_RUNTIME_URL).replace(/\/+$/, "");
}

export async function proxyToAgentRuntime(
  request: Request,
  options: AgentRuntimeProxyOptions = {},
): Promise<Response> {
  const base = agentRuntimeBaseUrl();
  const url = new URL(request.url);
  const target = `${base}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_REQUEST_HEADERS) headers.delete(name);
  // ADR-034 §2.5: every runtime call carries the workspace identity as headers.
  // The client sets them on the calls that start a session; the query-addressed
  // routes (status, events, session lists) get them from their parameters.
  const querySession = url.searchParams.get("sessionId")?.trim();
  const queryFolder = url.searchParams.get("cwd")?.trim();
  if (querySession && !headers.has(TUUM_SESSION_HEADER))
    headers.set(TUUM_SESSION_HEADER, querySession);
  if (queryFolder && !headers.has(TUUM_FOLDER_HEADER)) {
    headers.set(TUUM_FOLDER_HEADER, encodeURIComponent(queryFolder));
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (options.bodyLimitBytes) {
      const bounded = await readRequestBytesWithinLimit(request, options.bodyLimitBytes);
      if (!bounded.ok) return Response.json({ error: bounded.error }, { status: bounded.status });
      body = new ArrayBuffer(bounded.value.byteLength);
      new Uint8Array(body).set(bounded.value);
    } else {
      body = await request.arrayBuffer();
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return Response.json(
      {
        error: `agent runtime unreachable at ${base}: ${
          error instanceof Error ? error.message : "fetch failed"
        }`,
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("transfer-encoding");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
