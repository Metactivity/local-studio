// Service worker: one outbound WebSocket to the station's `/bridge/ws`,
// reconnecting with backoff; a chrome.alarms tick keeps the worker alive and
// pings the relay. The popup talks to us only through chrome.storage.local.

import { dispatch, METHODS, RpcError } from "./rpc";

type Settings = {
  stationUrl?: string;
  token?: string;
  pairCode?: string;
  readOnly?: boolean;
};
export type Status = "disconnected" | "connecting" | "pairing" | "connected" | "error";

const MAX_BACKOFF_MS = 30_000;
let socket: WebSocket | null = null;
let backoff = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let active = 0;

const store = () =>
  chrome.storage.local.get(["stationUrl", "token", "pairCode", "readOnly"]) as Promise<Settings>;

function setStatus(status: Status, lastError = ""): void {
  void chrome.storage.local.set({ status, lastError });
}

function badge(): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#d32f2f" });
  void chrome.action.setBadgeText({ text: active > 0 ? "●" : "" });
}

function wsUrl(stationUrl: string): string {
  const url = new URL(stationUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/bridge/ws";
  url.search = "";
  return url.toString();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, backoff);
  backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
}

async function handle(ws: WebSocket, id: unknown, method: string, params: unknown): Promise<void> {
  active += 1;
  badge();
  try {
    const { readOnly } = await store();
    const result = await dispatch(method, params, readOnly !== false);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32000;
    const message = error instanceof Error ? error.message : String(error);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  } finally {
    active -= 1;
    badge();
  }
}

async function connect(): Promise<void> {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const settings = await store();
  if (!settings.stationUrl || (!settings.token && !settings.pairCode)) {
    setStatus("disconnected");
    return;
  }
  let target: string;
  try {
    target = wsUrl(settings.stationUrl);
  } catch {
    setStatus("error", "invalid station URL");
    return;
  }
  setStatus(settings.pairCode ? "pairing" : "connecting");
  const ws = new WebSocket(target);
  socket = ws;
  ws.onopen = () => {
    // Auth is the first frame, never the URL.
    const hello = settings.pairCode
      ? {
          type: "pair",
          code: settings.pairCode,
          methods: METHODS,
          readOnly: settings.readOnly !== false,
        }
      : {
          type: "auth",
          token: settings.token,
          methods: METHODS,
          readOnly: settings.readOnly !== false,
        };
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = (event) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "paired") {
      void chrome.storage.local.set({ token: frame.token, pairCode: "" });
      backoff = 1_000;
      setStatus("connected");
    } else if (frame.type === "ready") {
      backoff = 1_000;
      setStatus("connected");
    } else if (frame.type === "error") {
      setStatus("error", String(frame.message ?? "relay error"));
      if (settings.pairCode) void chrome.storage.local.set({ pairCode: "" });
    } else if (frame.jsonrpc === "2.0" && typeof frame.method === "string") {
      void handle(ws, frame.id, frame.method, frame.params);
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    void chrome.storage.local.get("status").then(({ status }) => {
      if (status !== "error") setStatus("disconnected");
    });
    scheduleReconnect();
  };
  ws.onerror = () => undefined;
}

function disconnect(): void {
  const ws = socket;
  socket = null;
  ws?.close(1000, "settings changed");
}

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

// MV3 workers idle out after 30 s; a WebSocket only keeps them alive while
// frames flow, so the alarm both pings and re-dials.
void chrome.alarms.create("tuum-bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  else void connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.readOnly && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "state", readOnly: changes.readOnly.newValue !== false }));
  }
  if (
    changes.stationUrl ||
    (changes.pairCode && changes.pairCode.newValue) ||
    (changes.token && !changes.token.newValue)
  ) {
    disconnect();
    backoff = 1_000;
    void connect();
  }
});

void connect();
