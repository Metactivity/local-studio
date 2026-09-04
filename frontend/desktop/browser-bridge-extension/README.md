# Tuum Browser Bridge (Chrome extension)

The browser half of the Browser Bridge (MET-921): a Manifest V3 extension that
dials a Tuum / Local Studio station outbound and serves its `chrome_*` tools —
your own Chrome, your own profile and logins, on your screen.

## Build

```sh
cd frontend/desktop/browser-bridge-extension
bun install
bun run build        # → dist-chrome/ (background.js, popup.js, popup.html, manifest.json)
bun test             # dispatcher against a stubbed chrome.*
```

## Load (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** → pick `frontend/desktop/browser-bridge-extension/dist-chrome/`.
3. Pin "Tuum Browser Bridge" so the badge is visible.

## Pair

1. In Tuum Web, open the agent panel → **ACE** tab → **Browser bridge** → **Pair a browser**.
   The card shows the station URL and a 6-digit code (valid 5 minutes, single use).
2. Click the extension icon, enter the station URL and the code, **Pair**.
   The station must be reachable from this machine on a loopback address:
   locally that is `http://127.0.0.1:8081`; for a station on another host,
   tunnel first (`ssh -L 18081:127.0.0.1:8081 user@station`) and use
   `http://127.0.0.1:18081`.
3. The popup reads **Connected**; the card in Tuum reads **connected**. The
   bearer token the relay minted lives in `chrome.storage.local` only and is
   sent as the first WebSocket frame on every reconnect — never in a URL.

**Allow actions** is off by default: `chrome_click`, `chrome_fill` and
`chrome_eval` are refused with `-32002 read-only mode` until you switch it on.
A red badge shows while a request is running. **Forget** drops the token; the
station side keeps nothing you need to clean up (delete
`<data dir>/browser-bridge.json` to revoke every token at once).

## What it can do

`browser.navigate | url | text | html | screenshot | click | fill | scroll |
eval | tabs.list | tabs.new | tabs.switch | tabs.close`, implemented with
`chrome.tabs`, `chrome.scripting.executeScript` (isolated world: the DOM, not
the page's JS globals) and `chrome.tabs.captureVisibleTab` (visible viewport
as a PNG data URI; `fullPage` is accepted and ignored).

Permissions: `tabs`, `scripting`, `activeTab`, `storage`, `alarms`; host
`<all_urls>`. Unpacked distribution only.
