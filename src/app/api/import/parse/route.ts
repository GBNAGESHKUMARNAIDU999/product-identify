import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { parseXlsx } from "@/lib/parsers/xlsx";
import { parseDocx } from "@/lib/parsers/docx";
import { extractSheetId, extractFolderId, fetchGoogleSheet, parseDriveFolder, exportSheetXlsx } from "@/lib/parsers/google";
import { getGoogleCredential } from "@/lib/google-auth";
import { sha256 } from "@/lib/crypto";

export const maxDuration = 60;

const MAX_SOURCE_BYTES = 100 * 1024 * 1024; // 100MB catalog source cap
const TMP = path.join(process.cwd(), ".data", "tmp");

function authHeaderFor(token: string, mode: "api_key" | "oauth"): Record<string, string> {
  return mode === "oauth" ? { Authorization: `Bearer ${token}` } : {};
}

interface ParsedSource {
  columns: string[];
  rows: Record<string, string>[];
  rowImages: (string | null)[]; // image filename per row, from the parser
  images: Record<string, Buffer>; // filename -> original bytes
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const kind = (form.get("kind") as string | null) ?? "auto";
    const file = form.get("file") as File | null;
    const url = (form.get("url") as string | null)?.trim() || null;

    let sourceType: "xlsx" | "docx" | "gsheet" | "gdrive";
    let inventoryName: string;
    let fingerprint: string;
    let rawFileStorageKey: string | null = null;
    let parsed: ParsedSource;
    let gsheetWarning: string | undefined;

    if (file && (kind === "auto" || kind === "xlsx" || kind === "docx")) {
      if (file.size > MAX_SOURCE_BYTES) {
        return NextResponse.json({ error: `File exceeds ${MAX_SOURCE_BYTES / 1024 / 1024}MB limit.` }, { status: 413 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      if (!["xlsx", "xls", "docx"].includes(ext)) {
        return NextResponse.json({ error: "Unsupported file type. Use .xlsx, .xls or .docx." }, { status: 415 });
      }
      if (ext === "docx") {
        const d = await parseDocx(buf);
        parsed = { columns: d.columns, rows: d.rows.map((r) => r.cells), rowImages: d.rows.map((r) => r.imageFilename), images: d.images };
      } else {
        const x = parseXlsx(buf);
        parsed = { columns: x.columns, rows: x.rows.map((r) => r.cells), rowImages: x.rows.map((r) => r.imageFilename), images: x.images };
      }
      sourceType = ext === "docx" ? "docx" : "xlsx";
      inventoryName = file.name.replace(/\.(xlsx|xls|docx)$/i, "");
      fingerprint = sha256(buf);
      const rawKey = `raw/${fingerprint}.${ext}`;
      const rawPath = path.join(process.cwd(), ".data", "storage", rawKey);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.writeFile(rawPath, buf); // untouched copy for reference; DB is the app's single write target
      rawFileStorageKey = rawKey;
    } else if (url) {
      const cred = await getGoogleCredential();
      if (!cred) {
        return NextResponse.json(
          { error: "No Google credential configured. Add one on the Settings page first." },
          { status: 400 }
        );
      }
      const { token: gToken, mode } = cred;

      const sheetId = extractSheetId(url);
      const folderId = sheetId ? null : extractFolderId(url);
      if (sheetId && (kind === "auto" || kind === "gsheet")) {
        const { columns, rows } = await fetchGoogleSheet(sheetId, gToken, mode);
        let finalColumns = columns;
        let finalRows = rows;
        let images: Record<string, Buffer> = {};
        let rowImages: (string | null)[] = rows.map(() => null);
        let warning: string | undefined;

        // The Sheets v4 values API returns blank for images INSERTED into
        // cells — they are only reachable by exporting the sheet to xlsx via
        // the Drive API, where they survive as anchored drawings the Excel
        // parser already maps back to rows.
        try {
          const xlsx = await exportSheetXlsx(sheetId, gToken, mode);
          const parsed = parseXlsx(xlsx);
          if (Object.keys(parsed.images).length > 0) {
            finalColumns = parsed.columns;
            finalRows = parsed.rows.map((r) => r.cells);
            rowImages = parsed.rows.map((r) => r.imageFilename);
            images = parsed.images;
          }
        } catch (e) {
          warning = e instanceof Error ? e.message : "Sheet export for embedded images failed.";
        }

        // Fallback for =IMAGE("…") formulas / pasted URLs: the values API does
        // return those as text — download them so each row gets its picture.
        if (Object.keys(images).length === 0) {
          const photoCols = finalColumns.filter((c) => /(photo|image|img|picture)/i.test(c));
          for (let i = 0; i < finalRows.length && Object.keys(images).length < 500; i++) {
            for (const col of photoCols) {
              const val = finalRows[i][col]?.trim();
              if (!val || !/^https?:\/\//i.test(val)) continue;
              try {
                const res = await fetch(val, {
                  headers: val.includes("googleapis.com") ? authHeaderFor(gToken, mode) : {},
                  redirect: "follow",
                });
                if (!res.ok) continue;
                const type = res.headers.get("content-type") ?? "";
                if (!type.startsWith("image/")) continue;
                const ext = type.split("/")[1]?.split(";")[0] ?? "png";
                const name = finalRows[i][finalColumns[0]]?.trim() || `row-${i + 1}`;
                images[`${name}.${ext}`] = Buffer.from(await res.arrayBuffer());
                rowImages[i] = `${name}.${ext}`;
                break; // one image per row
              } catch {
                /* unreachable URL — leave this row without an image */
              }
            }
          }
        }

        if (!warning && Object.keys(images).length === 0 && finalColumns.some((c) => /(photo|image|img|picture)/i.test(c))) {
          warning =
            "No images came through. If the photos are inserted into the sheet cells, the Drive API must be enabled for your Google project so the sheet can be exported — rows still import fine, just without pictures.";
        }

        parsed = { columns: finalColumns, rows: finalRows, rowImages, images };
        sourceType = "gsheet";
        inventoryName = "Google Sheet";
        fingerprint = sha256(url + "\n" + JSON.stringify([finalColumns, finalRows]));
        gsheetWarning = warning;
      } else if (folderId && (kind === "auto" || kind === "gdrive")) {
        const d = await parseDriveFolder(folderId, gToken, mode);
        // rowImages resolved at commit time via the user-chosen image column;
        // parser-anchored images take precedence there.
        parsed = { columns: d.columns, rows: d.rows, rowImages: d.rows.map(() => null), images: d.images };
        sourceType = "gdrive";
        inventoryName = d.workbookName;
        fingerprint = sha256(url + "\n" + JSON.stringify([d.columns, d.rows]));
      } else {
        return NextResponse.json({ error: "Could not recognize that Google Sheets/Drive URL." }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: "Provide a file or a Google Sheets/Drive URL." }, { status: 400 });
    }

    // Stash parsed payload (incl. base64 images) for the confirm/commit step.
    await fs.mkdir(TMP, { recursive: true });
    const stashId = crypto.randomUUID();
    const imagesB64: Record<string, string> = {};
    for (const [name, buf] of Object.entries(parsed.images)) imagesB64[name] = buf.toString("base64");
    const stash = {
      sourceType,
      inventoryName,
      fingerprint,
      rawFileStorageKey,
      columns: parsed.columns,
      rows: parsed.rows,
      rowImages: parsed.rowImages,
      imageNames: Object.keys(parsed.images),
      imagesB64,
    };
    await fs.writeFile(path.join(TMP, `${stashId}.json`), JSON.stringify(stash));

    return NextResponse.json({
      stashId,
      sourceType,
      inventoryName,
      columns: parsed.columns,
      totalRows: parsed.rows.length,
      sampleRows: parsed.rows.slice(0, 4),
      imageCount: Object.keys(parsed.images).length,
      suggestedMapping: suggestMapping(parsed.columns),
      ...(gsheetWarning ? { warning: gsheetWarning } : {}),
    });
  } catch (err) {
    console.error("import/parse failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

function suggestMapping(columns: string[]): { sku?: string; name?: string; category?: string; image?: string } {
  const pick = (re: RegExp) => columns.find((c) => re.test(c));
  return {
    sku: pick(/^(sku|item\s*(code|no|number|id)|code|part\s*(no|number)|article)$/i),
    name: pick(/^(item\s*)?(name|title|description|product|label)$/i) ??
      // Word imports keep the item heading in "content"; treat it as the name.
      (columns.includes("content") ? "content" : undefined),
    category: pick(/(category|type|group|class)/i),
    image: pick(/(image|photo|img|picture|file ?name)/i),
  };
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Defensive: never echo potential key material from provider errors.
  return msg.replace(/[A-Za-z0-9_-]{30,}/g, (m) => (m.includes(" ") ? m : "[redacted]"));
}
