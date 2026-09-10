import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Deep search over every attribute column of the imported inventory(ies).
// Facets are DISCOVERED from the data, not hardcoded: a column becomes a
// filter when it is short and categorical (few distinct, short values);
// long free-text columns are only searched, never faceted.

const MAX_FACET_VALUES = 30;
const MAX_DISTINCT_FOR_FACET = 50;
const MAX_VALUE_LEN_FOR_FACET = 40;
const PAGE_SIZE = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const inventoryId = url.searchParams.get("inventoryId") || null;
  // Repeatable facet selections: ?f=Category:Biker&f=Sold/Unsold:Sold
  const facetSel: Record<string, Set<string>> = {};
  for (const f of url.searchParams.getAll("f")) {
    const i = f.indexOf(":");
    if (i <= 0) continue;
    const col = f.slice(0, i);
    const val = f.slice(i + 1);
    (facetSel[col] ??= new Set()).add(val);
  }

  const items = await prisma.inventoryItem.findMany({
    where: inventoryId ? { inventoryId } : {},
    orderBy: { rowIndex: "asc" },
  });

  const inventories = await prisma.inventory.findMany({ select: { id: true, name: true } });
  const invName = new Map(inventories.map((i) => [i.id, i.name]));

  const parsed = items.map((it) => ({
    raw: it,
    attrs: safeParse(it.attributesJson),
  }));

  // Column discovery in stable first-seen order.
  const columnOrder: string[] = [];
  const columnSeen = new Set<string>();
  for (const p of parsed) {
    for (const k of Object.keys(p.attrs)) {
      if (!columnSeen.has(k)) {
        columnSeen.add(k);
        columnOrder.push(k);
      }
    }
  }

  // Text query: match against sku/name/category AND every attribute value.
  const textMatched = q
    ? parsed.filter(({ raw, attrs }) =>
        [raw.sku, raw.name, raw.category, ...Object.values(attrs)].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(q)
        )
      )
    : parsed;

  // Facet selections applied on top of the text-matched set.
  const facetMatched = textMatched.filter(({ attrs }) =>
    Object.entries(facetSel).every(([col, vals]) => vals.has((attrs[col] ?? "").trim()))
  );

  // Facet metadata: value counts over the text-matched set (so counts stay
  // meaningful while typing). Only columns that qualify as categorical.
  const facets = columnOrder
    .map((col) => {
      const counts = new Map<string, number>();
      let maxValueLen = 0;
      for (const p of textMatched) {
        const v = (p.attrs[col] ?? "").trim();
        if (!v) continue;
        maxValueLen = Math.max(maxValueLen, v.length);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      if (counts.size < 2 || counts.size > MAX_DISTINCT_FOR_FACET) return null;
      if (maxValueLen > MAX_VALUE_LEN_FOR_FACET) return null;
      const values = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_FACET_VALUES)
        .map(([value, count]) => ({ value, count }));
      return { column: col, values };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const total = facetMatched.length;
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageItems = facetMatched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return NextResponse.json({
    query: q,
    total,
    page,
    pageSize: PAGE_SIZE,
    searchedColumns: columnOrder,
    facets,
    items: pageItems.map(({ raw, attrs }) => ({
      id: raw.id,
      inventoryId: raw.inventoryId,
      inventoryName: invName.get(raw.inventoryId) ?? null,
      rowIndex: raw.rowIndex,
      sku: raw.sku,
      name: raw.name,
      category: raw.category,
      hasImage: !!raw.imageStorageKey,
      imageUrl: raw.imageStorageKey ? `/api/items/${raw.id}/image` : null,
      attributes: attrs,
    })),
  });
}

function safeParse(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}
