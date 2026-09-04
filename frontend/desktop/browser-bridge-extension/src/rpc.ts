// The `browser.*` methods of the Tuum Browser Bridge, on top of chrome.tabs and
// chrome.scripting. Pure dispatch: the service worker owns the socket and the
// approval switch, this file only turns a method + params into Chrome calls.
// Injected functions are serialized by Chrome, so each is self-contained.

export const READ_ONLY = -32002;
export const BROWSER_ERROR = -32000;
export const METHOD_NOT_FOUND = -32601;

/** Methods that act as the signed-in user; refused while the switch is read-only. */
const ACTING = new Set(["browser.eval", "browser.click", "browser.fill"]);
const NAVIGATE_TIMEOUT_MS = 30_000;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;
type Handler = (params: Params) => Promise<unknown>;

const str = (params: Params, key: string): string | undefined =>
  typeof params[key] === "string" ? (params[key] as string) : undefined;

const need = (params: Params, key: string): string => {
  const value = str(params, key);
  if (!value) throw new RpcError(-32602, `${key} is required`);
  return value;
};

const tabId = (value: unknown): number => {
  const id = Number(value);
  if (!Number.isInteger(id)) throw new RpcError(-32602, "tab id must be a number");
  return id;
};

async function activeTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== "number") throw new RpcError(BROWSER_ERROR, "no active tab");
  return tab as chrome.tabs.Tab & { id: number };
}

const summary = (tab: chrome.tabs.Tab) => ({
  id: tab.id,
  url: tab.url ?? "",
  title: tab.title ?? "",
  active: tab.active,
  windowId: tab.windowId,
});

async function inPage<A extends unknown[], R>(
  id: number,
  func: (...args: A) => R,
  args: A,
): Promise<R> {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func, args });
  return frame?.result as R;
}

// ─── injected functions (serialized; no closures over this module) ────────

function pageText(selector?: string): string | null {
  const element = selector ? document.querySelector<HTMLElement>(selector) : document.body;
  return element ? element.innerText : null;
}

function pageHtml(selector?: string): string | null {
  const element = selector ? document.querySelector(selector) : document.documentElement;
  return element ? element.outerHTML : null;
}

function pageClick(selector: string): { found: boolean } {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { found: false };
  element.scrollIntoView({ block: "center" });
  element.click();
  return { found: true };
}

function pageFill(selector: string, value: string, submit: boolean): { found: boolean } {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!element) return { found: false };
  element.focus();
  // Through the prototype setter so React-style controlled inputs see the change.
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) element.form?.requestSubmit();
  return { found: true };
}

function pageScroll(dy: number, selector?: string): { x: number; y: number } {
  const element = selector ? document.querySelector(selector) : null;
  if (element) element.scrollBy(0, dy);
  else window.scrollBy(0, dy);
  return { x: window.scrollX, y: window.scrollY };
}

function pageEval(expression: string): unknown {
  // Isolated world: the DOM is visible, the page's own JS globals are not.
  const value = (0, eval)(expression);
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

// ─── handlers ─────────────────────────────────────────────────────────────

function waitForLoad(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new RpcError(BROWSER_ERROR, "page did not finish loading"));
    }, NAVIGATE_TIMEOUT_MS);
    const listener = (updatedId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (updatedId !== id || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export const HANDLERS: Record<string, Handler> = {
  "browser.navigate": async (params) => {
    const url = need(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new RpcError(-32602, "url must be absolute http(s)");
    const tab = await activeTab();
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url });
    await loaded;
    const after = await chrome.tabs.get(tab.id);
    return { url: after.url ?? url, title: after.title ?? "" };
  },
  "browser.url": async () => {
    const tab = await activeTab();
    return { url: tab.url ?? "", title: tab.title ?? "" };
  },
  "browser.text": async (params) => ({
    text: await inPage((await activeTab()).id, pageText, [str(params, "selector")]),
  }),
  "browser.html": async (params) => ({
    html: await inPage((await activeTab()).id, pageHtml, [str(params, "selector")]),
  }),
  "browser.screenshot": async () => {
    const tab = await activeTab();
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  },
  "browser.click": async (params) =>
    inPage((await activeTab()).id, pageClick, [need(params, "selector")]),
  "browser.fill": async (params) =>
    inPage((await activeTab()).id, pageFill, [
      need(params, "selector"),
      need(params, "value"),
      params.submit === true,
    ]),
  "browser.scroll": async (params) => {
    const dy = Number(params.dy);
    if (!Number.isFinite(dy)) throw new RpcError(-32602, "dy must be a number");
    return inPage((await activeTab()).id, pageScroll, [dy, str(params, "selector")]);
  },
  "browser.eval": async (params) =>
    inPage((await activeTab()).id, pageEval, [need(params, "expression")]),
  "browser.tabs.list": async () => (await chrome.tabs.query({})).map(summary),
  "browser.tabs.new": async (params) =>
    summary(await chrome.tabs.create({ url: str(params, "url") })),
  "browser.tabs.switch": async (params) => {
    const tab = await chrome.tabs.update(tabId(params.id), { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  },
  "browser.tabs.close": async (params) => {
    await chrome.tabs.remove(tabId(params.id));
    return { ok: true };
  },
};

export const METHODS = Object.keys(HANDLERS);

export async function dispatch(
  method: string,
  params: unknown,
  readOnly: boolean,
): Promise<unknown> {
  const handler = HANDLERS[method];
  if (!handler) throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
  if (readOnly && ACTING.has(method)) throw new RpcError(READ_ONLY, "read-only mode");
  const record =
    params && typeof params === "object" && !Array.isArray(params) ? (params as Params) : {};
  return handler(record);
}
