// Renders the identify result stored by the background worker. Reads exactly
// the same JSON the in-app Identify page consumes; image URLs are relative to
// the app server, so they are prefixed with the configured server URL.

const DEFAULT_SERVER = "http://localhost:3000";
const SKIP_ATTRS = new Set(["__parsed_extra"]);

async function getServer() {
  const { serverUrl } = await chrome.storage.sync.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

const { lastResult } = await chrome.storage.local.get("lastResult");
const content = document.getElementById("content");
const meta = document.getElementById("meta");

if (!lastResult) {
  content.innerHTML = `<div class="banner warn"><div><b>No result yet</b><small>Right-click any product image and choose “Identify with InventoryLens”.</small></div></div>`;
} else if (!lastResult.ok) {
  content.innerHTML = `<div class="banner err"><div><b>Identify failed</b><small>${esc(lastResult.error ?? "")}</small></div></div>`;
} else {
  const r = lastResult.identify;
  const server = lastResult.server ?? (await getServer());
  meta.textContent = `Matched at ${new Date(lastResult.at).toLocaleString()} · model ${r.vectorModel ?? "?"}`;

  const exact = !!r.exactMatch;
  const confident = !!r.confident;
  const banner = exact
    ? `<div class="banner ok"><div><b>Exact match — 100%</b><small>Photo is byte-identical to the catalog image.</small></div></div>`
    : confident
      ? `<div class="banner ok"><div><b>Likely match — ${(r.confidence * 100).toFixed(1)}%${r.rerank?.bestItemId ? " · vision-verified" : ""}</b><small>${r.rerank?.reason ?? "Always verify visually before acting on a match."}</small></div></div>`
      : `<div class="banner warn"><div><b>Below ${(r.threshold * 100).toFixed(0)}% confidence — top ${r.candidates.length} candidates</b><small>${r.rerank?.reason ?? "Human confirmation required."}</small></div></div>`;

  const best = r.candidates[0];
  const pairs = best
    ? Object.entries(best.item.attributes).filter(([k, v]) => !SKIP_ATTRS.has(k) && v)
    : [];

  content.innerHTML = `
    ${banner}
    <div class="cols">
      <div class="card">
        <div class="label">Queried image</div>
        <img class="photo" src="${r.uploadedPreview}" alt="query" />
        <div class="foot">${esc(lastResult.srcUrl ?? "")}</div>
      </div>
      <div class="card">
        <div class="label">Best catalog match</div>
        ${best ? bestCard(best, server) : '<p class="sub">No candidates.</p>'}
      </div>
    </div>
    ${r.candidates.length > 1 ? `<div class="cands"><div class="label">All candidates</div><div class="grid">${r.candidates.map((c, i) => candCard(c, server, i)).join("")}</div></div>` : ""}
    <p class="foot">Threshold ${(r.threshold * 100).toFixed(0)}% · every result carries a confidence score — confirm inside the InventoryLens app to feed the accuracy loop.</p>
  `;
}

function bestCard(c, server) {
  const url = c.item.imageUrl ? server + c.item.imageUrl : c.imageUrl;
  return `
    <img class="photo" src="${url}" alt="${esc(c.item.name ?? "match")}" />
    <div class="name">${esc(c.item.name ?? c.item.sku ?? "Unnamed item")} <span class="pct">${(c.score * 100).toFixed(1)}%</span></div>
    ${c.item.sku ? `<div class="sku">SKU: ${esc(c.item.sku)}</div>` : ""}
    <table>${Object.entries(c.item.attributes)
      .filter(([k, v]) => !SKIP_ATTRS.has(k) && v)
      .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join("")}</table>
  `;
}

function candCard(c, server, i) {
  const url = c.item.imageUrl ? server + c.item.imageUrl : c.imageUrl;
  const keys = Object.entries(c.item.attributes).filter(([k, v]) => !SKIP_ATTRS.has(k) && v).slice(0, 4);
  return `
    <div class="cand">
      <span class="rank">#${i + 1} · ${(c.score * 100).toFixed(1)}%</span>
      <img src="${url}" alt="${esc(c.item.name ?? "candidate")}" />
      <div class="name" style="font-size:13px">${esc(c.item.name ?? c.item.sku ?? "Unnamed item")}</div>
      ${c.item.sku ? `<div class="sku">SKU: ${esc(c.item.sku)}</div>` : ""}
      ${keys.map(([k, v]) => `<div class="sku"><b>${esc(k)}:</b> ${esc(v)}</div>`).join("")}
    </div>
  `;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
