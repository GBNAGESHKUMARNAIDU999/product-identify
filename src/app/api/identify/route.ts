import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { putObject, newKey, getObject } from "@/lib/storage";
import { embedImage, cosine, EMBEDDING_MODEL_ID } from "@/lib/embeddings";
import { rateLimit } from "@/lib/rate-limit";
import { reRankWithVision, makeThumbDataUrl } from "@/lib/vision";
import { sha256 } from "@/lib/crypto";

export const maxDuration = 60;

const MAX_QUERY_BYTES = 10 * 1024 * 1024;
const DEFAULT_THRESHOLD = 0.7;
const CANDIDATE_COUNT = 3;
const RATE_LIMIT = 20; // identifies per window per IP
const RATE_WINDOW_MS = 60 * 1000;

export async function POST(req: NextRequest) {
  // Rate limit before any model/provider spend.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const rl = rateLimit(`identify:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit reached. Retry in ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("image") as File | null;
    const inventoryScope = (form.get("inventoryId") as string | null) || null;
    // Re-rank defaults ON (it's the accuracy backstop); clients opt out explicitly.
    const wantRerank = (form.get("rerank") ?? "true") !== "false";

    if (!file) return NextResponse.json({ error: "image file required" }, { status: 400 });
    if (file.size > MAX_QUERY_BYTES) return NextResponse.json({ error: "Image exceeds 10MB limit." }, { status: 413 });
    const mime = file.type || "";
    if (mime && !mime.startsWith("image/")) return NextResponse.json({ error: "Only image uploads are accepted." }, { status: 415 });

    const buf = Buffer.from(await file.arrayBuffer());

    // Embed with the same engine as the catalog (structural guarantee).
    let queryVec: number[];
    try {
      queryVec = await embedImage(buf);
    } catch {
      return NextResponse.json({ error: "Could not read that image." }, { status: 400 });
    }

    // Vector search: load catalog embeddings (scoped), cosine in process.
    // Fine at internal-tool scale; see README for pgvector migration notes.
    const rows = await prisma.itemImageEmbedding.findMany({
      where: inventoryScope ? { item: { inventoryId: inventoryScope } } : {},
      include: { item: true },
    });
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "No embedded catalog images yet. Import an inventory with images first." },
        { status: 409 }
      );
    }

    const scored = rows
      .map((r) => ({ row: r, score: cosine(queryVec, JSON.parse(r.embedding) as number[]) }))
      .sort((a, b) => b.score - a.score);

    const threshold = parseFloat(process.env.MATCH_THRESHOLD ?? String(DEFAULT_THRESHOLD));
    // Dedupe by item (an item can hold several embedding rows, e.g. after a
    // model migration) so the top-N list is always N distinct items.
    const top: typeof scored = [];
    const seenItems = new Set<string>();
    for (const s of scored) {
      if (seenItems.has(s.row.inventoryItemId)) continue;
      seenItems.add(s.row.inventoryItemId);
      top.push(s);
      if (top.length >= Math.max(CANDIDATE_COUNT, 1)) break;
    }
    const best = top[0];
    let bestScore = Math.max(0, best.score); // pHash cosine maps [-1,1]; floor at 0

    // Exact-match check: a photo that is byte-identical to a catalog image is a
    // 100% match by construction — no need to trust a perceptual score for it.
    // Only the top few candidates are hashed, so this stays cheap.
    const queryHash = sha256(buf);
    let exactMatch = false;
    let exactItemId: string | null = null;
    for (const t of top) {
      if (!t.row.item.imageStorageKey) continue;
      try {
        const catBuf = await getObject(t.row.item.imageStorageKey);
        if (sha256(catBuf) === queryHash) {
          exactMatch = true;
          exactItemId = t.row.inventoryItemId;
          bestScore = 1;
          break;
        }
      } catch {
        /* unreadable catalog image — skip exact check for it */
      }
    }

    let candidates = top.map((t) => ({
      itemId: t.row.inventoryItemId,
      score: Math.max(0, t.score),
      item: serializeItem(t.row.item),
    }));
    // Byte-identical candidate always leads, whatever the perceptual score said.
    if (exactMatch) {
      candidates = [...candidates].sort(
        (a, b) => (b.itemId === exactItemId ? 1 : 0) - (a.itemId === exactItemId ? 1 : 0) || b.score - a.score
      );
    }

    // Optional vision-LLM re-rank pass (user's key). Skipped when the exact
    // bytes already matched — no provider spend for a proven answer.
    let rerank: { bestItemId: string | null; reason: string } | null = null;
    if (wantRerank && !exactMatch) {
      try {
        const withThumbs = await Promise.all(
          top.map(async (t) => ({
            itemId: t.row.inventoryItemId,
            sku: t.row.item.sku,
            name: t.row.item.name,
            score: Math.max(0, t.score),
            imageDataUrl: await makeThumbDataUrl(await getObject(t.row.item.imageStorageKey!)),
          }))
        );
        const rr = await reRankWithVision(buf, withThumbs);
        rerank = { bestItemId: rr.bestItemId, reason: rr.reason };
        if (rr.bestItemId) {
          candidates = [...candidates].sort(
            (a, b) => (b.itemId === rr.bestItemId ? 1 : 0) - (a.itemId === rr.bestItemId ? 1 : 0) || b.score - a.score
          );
        }
      } catch (err) {
        rerank = { bestItemId: null, reason: err instanceof Error ? err.message : "re-rank failed" };
      }
    }

    // Verdict: an exact byte match or a vision-confirmed pick is confident.
    // If the vision pass explicitly rejected every candidate (or failed), don't
    // let the vector score overrule it — drop to candidate confirmation.
    const visionRejected = !!rerank && rerank.bestItemId === null;
    const confident = exactMatch || (!visionRejected && (bestScore >= threshold || !!rerank?.bestItemId));
    const topMatchItemId = exactMatch
      ? exactItemId
      : confident
        ? (rerank?.bestItemId ?? best.row.inventoryItemId)
        : null;
    const effectiveConfidence = bestScore;

    const storedKey = await putObject(newKey("identify-queries", extOf(file)), buf);
    const record = await prisma.identifyQuery.create({
      data: {
        uploadedImageStorageKey: storedKey,
        topMatchItemId,
        confidenceScore: effectiveConfidence,
        candidatesJson: JSON.stringify(candidates.map((c) => ({ itemId: c.itemId, score: c.score }))),
      },
    });

    return NextResponse.json({
      queryId: record.id,
      confident,
      exactMatch,
      threshold,
      confidence: effectiveConfidence,
      vectorModel: EMBEDDING_MODEL_ID,
      rerank,
      requiresConfirmation: !confident,
      candidates: candidates.map((c) => ({ ...c, imageUrl: `/api/items/${c.itemId}/image` })),
      uploadedPreview: `data:${file.type || "image/jpeg"};base64,${buf.toString("base64")}`,
    });
  } catch (err) {
    console.error("identify failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Identify failed. Check server logs." }, { status: 500 });
  }
}

function serializeItem(item: {
  id: string;
  sku: string | null;
  name: string | null;
  category: string | null;
  attributesJson: string;
  imageStorageKey: string | null;
  imageOriginalFilename: string | null;
}) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    attributes: safeParse(item.attributesJson),
    hasImage: !!item.imageStorageKey,
    imageUrl: item.imageStorageKey ? `/api/items/${item.id}/image` : null,
    imageOriginalFilename: item.imageOriginalFilename,
  };
}

function safeParse(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

function extOf(file: File): string {
  const ext = file.name?.toLowerCase().split(".").pop() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext) ? ext : "bin";
}
