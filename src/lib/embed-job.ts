import { prisma } from "./db";
import { getObject } from "./storage";
import { embedImage, EMBEDDING_MODEL_ID } from "./embeddings";
import { sha256 } from "./crypto";

// Batch embedding backfill. modelUsed encodes the image content hash
// ("<model>:<sha256>"), so re-syncs skip embeddings for unchanged images.

const running = new Set<string>();

export async function kickEmbeddingBackfill(inventoryId: string): Promise<void> {
  if (running.has(inventoryId)) return;
  running.add(inventoryId);
  void runBackfill(inventoryId).finally(() => running.delete(inventoryId));
}

export async function runBackfill(inventoryId: string): Promise<{ embedded: number; skipped: number }> {
  // Purge embeddings from older model versions so the candidate pool stays
  // score-consistent (v1/v2 vectors used different normalization).
  await prisma.itemImageEmbedding.deleteMany({
    where: { item: { inventoryId }, modelUsed: { not: { startsWith: `${EMBEDDING_MODEL_ID}:` } } },
  });
  const items = await prisma.inventoryItem.findMany({
    where: { inventoryId, imageStorageKey: { not: null } },
    include: { embeddings: true },
  });
  let embedded = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      const buf = await getObject(item.imageStorageKey!);
      const modelUsed = `${EMBEDDING_MODEL_ID}:${sha256(buf)}`;
      const existing = await prisma.itemImageEmbedding.findFirst({
        where: { inventoryItemId: item.id, modelUsed },
      });
      if (existing) {
        skipped++;
        continue;
      }
      const vec = await embedImage(buf);
      // Drop embeddings of previous image bytes (e.g. after a re-import fixed
      // a wrong row→image assignment) so stale vectors can't surface items.
      await prisma.itemImageEmbedding.deleteMany({
        where: { inventoryItemId: item.id, modelUsed: { not: modelUsed } },
      });
      await prisma.itemImageEmbedding.create({
        data: { inventoryItemId: item.id, embedding: JSON.stringify(vec), modelUsed },
      });
      embedded++;
    } catch (err) {
      console.error(`embedding failed for item ${item.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { embedded, skipped };
}

export async function embeddingStatus(inventoryId: string): Promise<{ items: number; withImages: number; embedded: number }> {
  const items = await prisma.inventoryItem.count({ where: { inventoryId } });
  const withImages = await prisma.inventoryItem.count({ where: { inventoryId, imageStorageKey: { not: null } } });
  const embedded = await prisma.itemImageEmbedding.count({
    where: { item: { inventoryId } },
  });
  return { items, withImages, embedded };
}
