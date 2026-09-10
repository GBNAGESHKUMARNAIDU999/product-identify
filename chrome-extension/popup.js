const input = document.getElementById("server");
const saved = document.getElementById("saved");
const state = document.getElementById("serverState");
const DEFAULT_SERVER = "http://localhost:3000";

async function getServer() {
  const { serverUrl } = await chrome.storage.sync.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

input.value = await getServer();

input.addEventListener("change", async () => {
  await chrome.storage.sync.set({ serverUrl: input.value.trim() || DEFAULT_SERVER });
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 1500);
  await ping();
});

async function ping() {
  const server = await getServer();
  state.innerHTML = "Checking server…";
  try {
    const res = await fetch(`${server}/api/inventories`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const total = (json.inventories ?? []).reduce((n, i) => n + (i.itemCount ?? 0), 0);
    state.innerHTML = `<span class="dot ok"></span> Connected — ${total} items in catalog`;
  } catch {
    state.innerHTML = `<span class="dot bad"></span> Server not reachable — start the app first`;
  }
}
await ping();

document.getElementById("results").addEventListener("click", async () => {
  const { lastResult } = await chrome.storage.local.get("lastResult");
  if (lastResult) await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
});

document.getElementById("app").addEventListener("click", async () => {
  await chrome.tabs.create({ url: await getServer() + "/inventories" });
});
