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
function authQuery(token: string, mode: "api_key" | "oauth"): string {
  return mode === "api_key" ? `?key=${encodeURIComponent(token)}` : "";
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
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${authQuery(token, mode)}`,
    { headers: authHeaders(token, mode) }
  );
  if (!metaRes.ok) throw new Error(`Sheets metadata failed (${metaRes.status}). Check the credential and sharing settings.`);
  const meta = (await metaRes.json()) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
  const sheetTitle = meta.sheets?.[0]?.properties?.title ?? "";
  const valuesRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetTitle)}${authQuery(token, mode)}`,
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
 * Exports a Google Sheet as xlsx bytes via the Drive export endpoint. This is
 * the only way to read images INSERTED into cells: the Sheets v4 values API
 * returns blank for them, while the xlsx export preserves them as anchored
 * drawings the Excel parser can map back to rows.
 */
export async function exportSheetXlsx(
  sheetId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<Buffer> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${sheetId}/export${authQuery(token, mode)}&mimeType=${encodeURIComponent(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )}`,
    { headers: authHeaders(token, mode) }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; details?: { reason?: string; metadata?: { activationUrl?: string } }[] };
    };
    const reason = body.error?.details?.find((d) => d.reason)?.reason;
    const activationUrl = body.error?.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
    if (res.status === 403 && (reason === "SERVICE_DISABLED" || activationUrl)) {
      throw new Error(
        `The Drive API is not enabled for this Google project, so images inserted in the sheet can't be read.${activationUrl ? ` Enable it here: ${activationUrl}` : ""}`
      );
    }
    throw new Error(`Sheet export failed (HTTP ${res.status})${body.error?.message ? `: ${body.error.message}` : ""}.`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Lists an Excel file inside a Drive folder (first .xlsx) + direct image files. */export async function fetchDriveFolder(
  folderId: string,
  token: string,
  mode: "api_key" | "oauth"
): Promise<{ files: { id: string; name: string; mimeType: string }[] }> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files${authQuery(token, mode)}&q=${q}&fields=files(id,name,mimeType)&pageSize=100`,
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
    `https://www.googleapis.com/drive/v3/files/${fileId}${authQuery(token, mode)}&alt=media`,
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
    // Export native Google Sheet to xlsx bytes via Drive export endpoint, then
    // reuse the Excel parser unchanged (one code path for anchor mapping).
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${sheet.id}/export${authQuery(token, mode)}&mimeType=${encodeURIComponent(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )}`,
      { headers: authHeaders(token, mode) }
    );
    if (!res.ok) throw new Error(`Drive export failed (${res.status}).`);
    const parsed = parseXlsx(Buffer.from(await res.arrayBuffer()));
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
