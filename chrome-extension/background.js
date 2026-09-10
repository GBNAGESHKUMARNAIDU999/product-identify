// InventoryLens extension background worker.
// Right-click an image anywhere on the web → download its bytes → POST to the
// local InventoryLens /api/identify (same API the app's Identify page uses) →
// open the results tab. The app server stays the single source of truth.

const DEFAULT_SERVER = "http://localhost:3000";
const MENU_ID = "inventorylens-identify";

async function getServer() {
  const { serverUrl } = await chrome.storage.sync.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Identify with InventoryLens",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  await runIdentify(info.srcUrl);
});

async function runIdentify(srcUrl) {
  let result;
  try {
    const server = await getServer();
    const imgRes = await fetch(srcUrl);
    if (!imgRes.ok) throw new Error(`Could not download that image (HTTP ${imgRes.status}).`);
    const blob = await imgRes.blob();
    if (!blob.type.startsWith("image/")) throw new Error("That URL is not an image.");

    const form = new FormData();
    form.set("image", blob, `query.${extOf(blob.type)}`);
    form.set("rerank", "true"); // same accuracy backstop as the in-app flow

    const res = await fetch(`${server}/api/identify`, { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Identify failed (HTTP ${res.status}).`);
    result = { ok: true, server, srcUrl, at: Date.now(), identify: json };
  } catch (err) {
    result = { ok: false, srcUrl, at: Date.now(), error: err instanceof Error ? err.message : "Identify failed" };
  }
  await chrome.storage.local.set({ lastResult: result });
  await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
}

function extOf(mime) {
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };
  return map[mime] ?? "jpg";
}
