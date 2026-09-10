import * as XLSX from "xlsx";
import AdmZip from "adm-zip";

// Excel parser: rows -> {columns, rows, images}.
// Embedded images are mapped to rows via their ONE-cell anchors in
// xl/drawings/drawing.xml (xlsx JS cannot do this natively).

export interface ParsedRow {
  rowIndex: number;
  cells: Record<string, string>;
  imageFilename: string | null;
}

export interface ParsedSheet {
  columns: string[];
  rows: ParsedRow[];
  images: Record<string, Buffer>; // filename -> original bytes
}

interface AnchorEntry {
  row: number;
  col: number;
  target: string; // e.g. "../media/image1.png"
}

export function parseXlsx(buf: Buffer): ParsedSheet {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("workbook has no sheets");

  const images: Record<string, Buffer> = {};
  for (const media of extractMedia(buf)) images[media.filename] = media.data;

  // Read the sheet as a matrix with blank rows PRESERVED, so every data row
  // keeps its true sheet position. Image anchors reference absolute sheet
  // rows; mapping them through a dense row list (blank rows collapsed) shifts
  // every image after a blank row onto the wrong item.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", blankrows: true, raw: false });
  const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const startRow = range.s.r; // matrix index 0 sits at this sheet row
  const headers = (matrix[0] ?? []).map((h) => String(h ?? "").trim());

  // Anchor rows are absolute 0-based sheet rows; the header occupies the first
  // row of the range, so an anchor on sheet row R belongs to matrix index R - startRow.
  const imageByRow = new Map<number, string>();
  for (const a of extractImageAnchors(buf)) {
    if (a.row > startRow && !imageByRow.has(a.row)) imageByRow.set(a.row, a.target);
  }

  const rows: ParsedRow[] = [];
  matrix.forEach((arr, r) => {
    if (r === 0) return; // header row
    const cells: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, c) => {
      if (!h) return;
      const v = arr[c] == null ? "" : String(arr[c]).trim();
      cells[h] = v;
      if (v !== "") hasValue = true;
    });
    const anchored = imageByRow.get(r + startRow);
    const imageFilename = anchored ? resolveMediaName(anchored, images) : null;
    if (!hasValue && !imageFilename) return; // skip truly blank rows
    rows.push({ rowIndex: rows.length, cells, imageFilename });
  });

  const columns = headers.filter(Boolean);
  return { columns, rows, images };
}

function resolveMediaName(target: string, images: Record<string, Buffer>): string | null {
  const base = target.split("/").pop();
  if (!base) return null;
  return images[base] ? base : null;
}

function extractMedia(buf: Buffer): { filename: string; data: Buffer }[] {
  const zip = new AdmZip(buf);
  const out: { filename: string; data: Buffer }[] = [];
  for (const e of zip.getEntries()) {
    if (/^xl\/media\//.test(e.entryName)) {
      out.push({ filename: e.entryName.replace("xl/media/", ""), data: e.getData() });
    }
  }
  return out;
}

function extractImageAnchors(buf: Buffer): AnchorEntry[] {
  const zip = new AdmZip(buf);
  const anchors: AnchorEntry[] = [];
  for (const e of zip.getEntries()) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(e.entryName)) continue;
    const xml = e.getData().toString("utf8");
    // Iterate each anchor block; <xdr:from><xdr:row>N</xdr:row><xdr:col>M</xdr:col>…
    const blocks = xml.match(/<xdr:(?:oneCellAnchor|twoCellAnchor)[\s\S]*?<\/xdr:(?:oneCellAnchor|twoCellAnchor)>/g) ?? [];
    for (const block of blocks) {
      const from = block.match(/<xdr:from>([\s\S]*?)<\/xdr:from>/);
      if (!from) continue;
      const row = from[1].match(/<xdr:row>(\d+)<\/xdr:row>/)?.[1];
      const col = from[1].match(/<xdr:col>(\d+)<\/xdr:col>/)?.[1];
      const embed = block.match(/r:embed="(rId\d+)"/)?.[1];
      if (!row || !embed) continue;
      // resolve rId -> media target via drawing rels
      const relsName = e.entryName.replace("drawings/", "drawings/_rels/") + ".rels";
      const relsEntry = zip.getEntries().find((r) => r.entryName === relsName);
      let target = "";
      if (relsEntry) {
        const rels = relsEntry.getData().toString("utf8");
        const relRe = new RegExp(`<Relationship[^>]*Id="${embed}"[^>]*Target="([^"]+)"`);
        target = rels.match(relRe)?.[1] ?? "";
      }
      if (target) anchors.push({ row: parseInt(row, 10), col: parseInt(col ?? "0", 10), target });
    }
  }
  return anchors;
}
