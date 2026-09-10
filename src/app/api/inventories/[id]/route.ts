import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const inv = await prisma.inventory.findUnique({
    where: { id: params.id },
    include: { _count: { select: { items: true } } },
  });
  if (!inv) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = 24;

  // Case-insensitive search done in JS: SQLite's `contains` is case-sensitive.
  const all = await prisma.inventoryItem.findMany({ where: { inventoryId: inv.id }, orderBy: { rowIndex: "asc" } });
  const filtered = q
    ? all.filter((it) =>
        [it.sku, it.name, it.category, it.attributesJson].some((f) => f?.toLowerCase().includes(q))
      )
    : all;
  const total = filtered.length;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({
    inventory: { id: inv.id, name: inv.name, sourceType: inv.sourceType, lastSyncedAt: inv.lastSyncedAt },
    total,
    page,
    pageSize,
    items: items.map((it) => ({
      id: it.id,
      rowIndex: it.rowIndex,
      sku: it.sku,
      name: it.name,
      category: it.category,
      hasImage: !!it.imageStorageKey,
      imageUrl: it.imageStorageKey ? `/api/items/${it.id}/image` : null,
      attributes: safeParse(it.attributesJson),
    })),
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  // Deletes the app's synced copy only — never the original source file.
  await prisma.inventory.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}

function safeParse(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}
