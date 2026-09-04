// The popup: connection state, the paired station, the approval switch, and
// the pairing form. Everything goes through chrome.storage.local; the service
// worker reacts to the changes.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const LABELS: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  pairing: "Pairing…",
  disconnected: "Disconnected",
  error: "Error",
};

async function render(): Promise<void> {
  const s = await chrome.storage.local.get([
    "stationUrl",
    "token",
    "readOnly",
    "status",
    "lastError",
    "pairCode",
  ]);
  const status = String(s.status ?? "disconnected");
  $("status").textContent = LABELS[status] ?? status;
  $("status").dataset.state = status;
  $("error").textContent = status === "error" ? String(s.lastError ?? "") : "";
  $("station").textContent = s.token ? String(s.stationUrl ?? "") : "not paired";
  $<HTMLInputElement>("act").checked = s.readOnly === false;
  $<HTMLInputElement>("act").disabled = !s.token;
  $<HTMLInputElement>("url").value = String(s.stationUrl ?? "http://127.0.0.1:8081");
  $<HTMLButtonElement>("forget").hidden = !s.token;
}

$<HTMLFormElement>("pair").addEventListener("submit", (event) => {
  event.preventDefault();
  const stationUrl = $<HTMLInputElement>("url").value.trim().replace(/\/+$/, "");
  const pairCode = $<HTMLInputElement>("code").value.trim();
  if (!stationUrl || !/^\d{6}$/.test(pairCode)) return;
  void chrome.storage.local.set({
    stationUrl,
    pairCode,
    token: "",
    status: "pairing",
    lastError: "",
  });
  $<HTMLInputElement>("code").value = "";
});

$<HTMLInputElement>("act").addEventListener("change", (event) => {
  void chrome.storage.local.set({ readOnly: !(event.target as HTMLInputElement).checked });
});

$("forget").addEventListener("click", () => {
  void chrome.storage.local.set({
    token: "",
    pairCode: "",
    readOnly: true,
    status: "disconnected",
    lastError: "",
  });
});

chrome.storage.onChanged.addListener(() => void render());
void render();
