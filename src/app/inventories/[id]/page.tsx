"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight, Search, ImageOff } from "lucide-react";

interface Item {
  id: string;
  rowIndex: number;
  sku: string | null;
  name: string | null;
  category: string | null;
  hasImage: boolean;
  imageUrl: string | null;
  attributes: Record<string, string>;
}

export default function InventoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [meta, setMeta] = useState<{ name: string; sourceType: string } | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/inventories/${id}?q=${encodeURIComponent(q)}&page=${page}`);
    if (!res.ok) return;
    const json = await res.json();
    setMeta(json.inventory);
    setItems(json.items);
    setTotal(json.total);
  }, [id, q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / 24));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <Link href="/inventories" className="inline-flex items-center gap-1.5 text-sm muted hover:text-slate-900">
        <ArrowLeft size={15} /> All inventories
      </Link>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{meta?.name ?? "…"}</h1>
          <p className="muted text-sm mt-1">{total} items · original columns preserved on every row</p>
        </div>
        <div className="relative w-72">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input !pl-9"
            placeholder="Search SKU, name, any column…"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>
      </header>

      {items === null ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="card p-3 animate-pulse space-y-2">
              <div className="aspect-square bg-slate-100 rounded-lg" />
              <div className="h-3 bg-slate-100 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="card p-12 text-center">
          <ImageOff className="mx-auto mb-3 text-slate-300" size={40} />
          <h3 className="font-medium">No matching items</h3>
          <p className="muted text-sm mt-1">{q ? `Nothing matches "${q}".` : "This inventory has no rows."}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {items.map((it) => (
            <button key={it.id} className="card card-hover p-3 text-left" onClick={() => setSelected(it)}>
              <div className="aspect-square rounded-lg overflow-hidden bg-slate-50 mb-2 flex items-center justify-center">
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.imageUrl} alt={it.name ?? it.sku ?? "item"} className="w-full h-full object-contain" loading="lazy" />
                ) : (
                  <ImageOff className="text-slate-300" size={28} />
                )}
              </div>
              <div className="text-sm font-medium truncate">{it.name ?? it.sku ?? `Row ${it.rowIndex + 1}`}</div>
              <div className="text-xs muted truncate">{it.sku ?? "—"}</div>
            </button>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button className="btn-ghost !py-1.5" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={15} />
          </button>
          <span className="muted">
            Page {page} of {pageCount}
          </span>
          <button className="btn-ghost !py-1.5" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight size={15} />
          </button>
        </div>
      )}

      {selected && <ItemDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ItemDrawer({ item, onClose }: { item: Item; onClose: () => void }) {
  const entries = Object.entries(item.attributes);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <div className="relative bg-white w-full max-w-md h-full shadow-xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">{item.name ?? item.sku ?? `Row ${item.rowIndex + 1}`}</h3>
            <p className="text-xs muted mt-0.5">{item.sku ?? "no SKU"}</p>
          </div>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt={item.name ?? "item"} className="w-full rounded-xl border mb-5 bg-slate-50 object-contain max-h-80" />
        )}
        <div className="divide-y rounded-xl border">
          {entries.length === 0 && <div className="px-4 py-3 text-sm muted">No attributes recorded.</div>}
          {entries.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[1fr_1.5fr] gap-3 px-4 py-2.5 text-sm">
              <span className="muted break-words">{k}</span>
              <span className="break-words">{v || "—"}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] muted mt-3">Values shown exactly as imported (attributes_json round-trip).</p>
      </div>
    </div>
  );
}
