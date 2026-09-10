import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { embeddingStatus } from "@/lib/embed-job";

export const dynamic = "force-dynamic";

export async function GET() {
  const inventories = await prisma.inventory.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { items: true } } },
  });
  const out = await Promise.all(
    inventories.map(async (inv) => ({
      id: inv.id,
      name: inv.name,
      sourceType: inv.sourceType,
      lastSyncedAt: inv.lastSyncedAt,
      itemCount: inv._count.items,
      embeddings: await embeddingStatus(inv.id),
    }))
  );
  return NextResponse.json({ inventories: out });
}
