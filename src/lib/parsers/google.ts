import { parseXlsx } from "./xlsx";

// Google Sheets/Drive readers. Read-only by construction: only GET requests.
// Auth uses the user's stored Google credential (Settings page):
//   - "api_key" mode: Google API key (works for public sheets/files)
//   - "oauth" mode: an OAuth access token with readonly scopes
// The mode is chosen when saving the credential (stored as provider "google").

export function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

export function extractFolderId(url: string): string | null {
  const m = url.match(/\/folders\/([a-zA-Z0-9-_]+)/) ?? url.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function authHeaders(token: string, mode: "api_key" | "oauth"): Record<string, string> {
  return mode === "oauth" ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Appends query params plus the auth param correctly for either mode. Never
 * concatenate by hand: in oauth mode there is no `?key=` segment, so
 * `...${authQuery()}&mimeType=` produces `/export&mimeType=…` — the params end
 * up in the path and Google answers 404.
 */
function withQuery(base: string, params: Record<string, string>, token: string, mode: "api_key" | "oauth"): string {
  const search = new URLSearchParams(params);
  if (mode === "api_key") search.set("key", token);
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

export interface GoogleFetchResult {
  name: string;
  buf: Buffer;
}

/** Reads a Google Sheet as parsed rows via the Sheets v4 API. */
export async function fetchGoogleSheet(
  sheetId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const metaRes = await fetch(
    withQuery(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {}, token, mode),
    { headers: authHeaders(token, mode) }
  );
  if (!metaRes.ok) throw new Error(`Sheets metadata failed (${metaRes.status}). Check the credential and sharing settings.`);
  const meta = (await metaRes.json()) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
  const sheetTitle = meta.sheets?.[0]?.properties?.title ?? "";
  const valuesRes = await fetch(
    withQuery(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetTitle)}`, {}, token, mode),
    { headers: authHeaders(token, mode) }
  );
  if (!valuesRes.ok) throw new Error(`Sheets values failed (${valuesRes.status}).`);
  const data = (await valuesRes.json()) as { values?: string[][] };
  const values = data.values ?? [];
  if (values.length === 0) return { columns: [], rows: [] };
  const columns = values[0].map((c, i) => c || `Column ${i + 1}`);
  const rows = values.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    columns.forEach((c, i) => (obj[c] = r[i] ?? ""));
    return obj;
  });
  return { columns, rows };
}

/**
 * Exports a Google Sheet as xlsx bytes. This is the only way to read images
 * INSERTED into cells: the Sheets v4 values API returns blank for them, while
 * the xlsx export preserves them as anchored drawings the Excel parser can map
 * back to rows.
 *
 * Uses the per-tab Docs download endpoint (docs.google.com/…/export), not
 * drive/v3 files/export: the latter caps whole-workbook exports
 * ("exportSizeLimitExceeded" for multi-tab sheets) and cannot select a tab.
 * Bearer auth is sent when present; link-shared public sheets export without
 * any auth.
 */
export async function exportSheetXlsx(
  sheetId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<Buffer> {
  const metaRes = await fetch(
    withQuery(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`, {}, token, mode),
    { headers: authHeaders(token, mode) }
  );
  if (!metaRes.ok) throw new Error(`Sheets metadata failed (${metaRes.status}). Check the credential and sharing settings.`);
  const meta = (await metaRes.json()) as { sheets?: { properties?: { sheetId?: number } }[] };
  const gid = meta.sheets?.[0]?.properties?.sheetId ?? 0;

  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx&gid=${gid}`,
    { headers: authHeaders(token, mode), redirect: "follow" }
  );
  if (!res.ok) {
    throw new Error(`Sheet export failed (HTTP ${res.status}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Google answers auth/sharing failures on this endpoint with a 200 HTML
  // page — reject it here so the xlsx parser never sees a non-zip payload.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error("Sheet export returned a non-xlsx response. Check the sheet is shared with the credential (view access).");
  }
  return buf;
}

/** Lists an Excel file inside a Drive folder (first .xlsx) + direct image files. */export async function fetchDriveFolder(
  folderId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<{ files: { id: string; name: string; mimeType: string }[] }> {
  const res = await fetch(
    withQuery(
      "https://www.googleapis.com/drive/v3/files",
      { q: `'${folderId}' in parents and trashed = false`, fields: "files(id,name,mimeType)", pageSize: "100" },
      token,
      mode
    ),
    { headers: authHeaders(token, mode) }
  );
  if (!res.ok) throw new Error(`Drive list failed (${res.status}). Check the credential and folder sharing.`);
  const json = (await res.json()) as { files?: { id: string; name: string; mimeType: string }[] };
  return { files: json.files ?? [] };
}

export async function downloadDriveFile(
  fileId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<GoogleFetchResult["buf"]> {
  const res = await fetch(
    withQuery(`https://www.googleapis.com/drive/v3/files/${fileId}`, { alt: "media" }, token, mode),
    { headers: authHeaders(token, mode) }
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** Drive folder flow: find first spreadsheet, export as xlsx, reuse Excel parser. */
export async function parseDriveFolder(
  folderId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<{ columns: string[]; rows: Record<string, string>[]; images: Record<string, Buffer>; workbookName: string }> {
  const { files } = await fetchDriveFolder(folderId, token, mode);
  const sheet = files.find((f) => f.mimeType === "application/vnd.google-apps.spreadsheet");
  const xlsxFile = files.find((f) => f.mimeType.includes("spreadsheetml") || f.name.toLowerCase().endsWith(".xlsx"));
  const images = files.filter((f) => f.mimeType.startsWith("image/"));

  if (sheet) {
    // Export native Google Sheet to xlsx bytes, then reuse the Excel parser
    // unchanged (one code path for anchor mapping).
    const buf = await exportSheetXlsx(sheet.id, token, mode);
    const parsed = parseXlsx(buf);
    // loose image files in the folder are also collected
    for (const img of images) {
      parsed.images[img.name] = await downloadDriveFile(img.id, token, mode);
    }
    return {
      columns: parsed.columns,
      rows: parsed.rows.map((r) => r.cells),
      images: parsed.images,
      workbookName: sheet.name,
    };
  }
  if (xlsxFile) {
    const buf = await downloadDriveFile(xlsxFile.id, token, mode);
    const parsed = parseXlsx(buf);
    return { columns: parsed.columns, rows: parsed.rows.map((r) => r.cells), images: parsed.images, workbookName: xlsxFile.name };
  }
  throw new Error("No spreadsheet found in that Drive folder.");
}
