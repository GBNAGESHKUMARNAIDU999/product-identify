import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { putObject, getObject } from "@/lib/storage";
import { sha256 } from "@/lib/crypto";
import { kickEmbeddingBackfill } from "@/lib/embed-job";

export const maxDuration = 120;

const TMP = path.join(process.cwd(), ".data", "tmp");

interface CommitBody {
  stashId: string;
  inventoryName?: string;
  mapping?: { sku?: string; name?: string; category?: string; image?: string };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CommitBody;
    if (!body.stashId) return NextResponse.json({ error: "stashId required" }, { status: 400 });

    const stashPath = path.join(TMP, `${body.stashId}.json`);
    let stash: {
      sourceType: string;
      inventoryName: string;
      fingerprint: string;
      rawFileStorageKey: string | null;
      columns: string[];
      rows: Record<string, string>[];
      rowImages: (string | null)[];
      imageNames: string[];
      imagesB64: Record<string, string>;
    };
    try {
      stash = JSON.parse(await fs.readFile(stashPath, "utf8"));
    } catch {
      return NextResponse.json({ error: "Stash expired or unknown — re-run the import preview." }, { status: 404 });
    }

    const inventoryName = (body.inventoryName ?? stash.inventoryName ?? "Untitled inventory").trim() || "Untitled inventory";
    const mapping = body.mapping ?? {};

    // Blank-cell scan: any empty/whitespace cell is written as "N/A" so records
    // never carry silent blanks — every field is explicit and values can't be
    // misread as missing or shifted columns.
    for (const row of stash.rows) {
      for (const [k, v] of Object.entries(row)) {
        if (v == null || String(v).trim() === "") row[k] = "N/A";
      }
    }

    // Idempotent inventory upsert keyed on (name, fingerprint).
    const inventory = await prisma.inventory.upsert({
      where: { name_sourceFingerprint: { name: inventoryName, sourceFingerprint: stash.fingerprint } },
      update: { lastSyncedAt: new Date(), sourceType: stash.sourceType, rawFileStorageKey: stash.rawFileStorageKey },
      create: {
        name: inventoryName,
        sourceType: stash.sourceType,
        sourceFingerprint: stash.fingerprint,
        sourceUrlOrPath: null,
        rawFileStorageKey: stash.rawFileStorageKey,
        lastSyncedAt: new Date(),
      },
    });

    const images: Record<string, Buffer> = {};
    for (const [name, b64] of Object.entries(stash.imagesB64 ?? {})) images[name] = Buffer.from(b64, "base64");

    const extFor = (filename: string): string => {
      const ext = filename.toLowerCase().split(".").pop() ?? "";
      return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg"].includes(ext) ? ext : "bin";
    };

    let imagesStored = 0;
    let itemsUpserted = 0;

    for (let i = 0; i < stash.rows.length; i++) {
      const cells = stash.rows[i] ?? {};
      const imgName =
        stash.rowImages?.[i] ??
        resolveImageByCell(mapping.image, cells, images);

      let imageStorageKey: string | null = null;
      let imageOriginalFilename: string | null = null;
      if (imgName && images[imgName]) {
        const bytes = images[imgName];
        const key = `inventories/${inventory.id}/items/${i}.${extFor(imgName)}`;
        let unchanged = false;
        try {
          const prev = await getObject(key);
          unchanged = sha256(prev) === sha256(bytes);
        } catch {
          unchanged = false;
        }
        if (!unchanged) await putObject(key, bytes); // verbatim bytes, no re-encode
        imageStorageKey = key;
        imageOriginalFilename = imgName;
        if (!unchanged) imagesStored++;
      }

      const data = {
        attributesJson: JSON.stringify(cells), // original column names preserved verbatim
        sku: mapping.sku ? cells[mapping.sku] || null : null,
        name: mapping.name ? cells[mapping.name] || null : null,
        category: mapping.category ? cells[mapping.category] || null : null,
        // Always mirror the source: rows whose image disappeared from the
        // source get cleared instead of keeping a stale assignment.
        imageStorageKey,
        imageOriginalFilename,
      };

      await prisma.inventoryItem.upsert({
        where: { inventoryId_rowIndex: { inventoryId: inventory.id, rowIndex: i } },
        update: data,
        create: { inventoryId: inventory.id, rowIndex: i, ...data },
      });
      itemsUpserted++;
    }

    // Remove rows that disappeared from the source since last sync.
    await prisma.inventoryItem.deleteMany({
      where: { inventoryId: inventory.id, rowIndex: { gte: stash.rows.length } },
    });

    // Clean the stash.
    await fs.rm(stashPath, { force: true });

    void kickEmbeddingBackfill(inventory.id);

    return NextResponse.json({
      inventoryId: inventory.id,
      inventoryName: inventory.name,
      itemCount: itemsUpserted,
      imagesStored,
      embeddingsScheduled: true,
      note: "Embeddings are generating in the background; Identify works with whatever is embedded so far.",
    });
  } catch (err) {
    console.error("import/commit failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "commit failed" }, { status: 500 });
  }
}

function resolveImageByCell(
  imageColumn: string | undefined,
  cells: Record<string, string>,
  images: Record<string, Buffer>
): string | null {
  if (!imageColumn) return null;
  const val = cells[imageColumn]?.trim();
  if (!val) return null;
  const base = val.split(/[\/\\]/).pop()?.trim();
  if (base && images[base]) return base;
  if (images[val]) return val;
  return null;
}
