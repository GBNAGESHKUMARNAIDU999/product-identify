"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSearch, X, ImageIcon, SlidersHorizontal } from "lucide-react";

interface FacetValue {
  value: string;
  count: number;
}
interface Facet {
  column: string;
  values: FacetValue[];
}
interface SearchItem {
  id: string;
  inventoryId: string;
  inventoryName: string | null;
  rowIndex: number;
  sku: string | null;
  name: string | null;
  category: string | null;
  hasImage: boolean;
  imageUrl: string | null;
  attributes: Record<string, string>;
}
interface SearchResponse {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  searchedColumns: string[];
  facets: Facet[];
  items: SearchItem[];
}

interface InventoryOption {
  id: string;
  name: string;
  itemCount: number;
}

const HIGHLIGHT_KEYS = ["Sr. No.", "Product Make", "Category", "Segment", "Product Size", "Sold/Unsold", "Tag Name"];

export default function DeepSearchPage() {
  const [inventories, setInventories] = useState<InventoryOption[]>([]);
  const [scope, setScope] = useState("");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [data, setData] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded] = useState<Record<string, boolean>>({});
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [openItem, setOpenItem] = useState<SearchItem | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/inventories");
      const json = await res.json();
      setInventories(json.inventories ?? []);
    })();
  }, []);

  const selectedParam = useMemo(
    () =>
      Object.entries(selected).flatMap(([col, vals]) => [...vals].map((v) => `${col}:${v}`)).sort(),
    [selected]
  );

  const runSearch = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (scope) params.set("inventoryId", scope);
      for (const f of selectedParam) params.append("f", f);
      const res = await fetch(`/api/search?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }, [query, scope, selectedParam]);

  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, selectedParam]);

  const toggleFacet = (col: string, val: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const cur = new Set(next[col] ?? []);
      if (cur.has(val)) cur.delete(val);
      else cur.add(val);
      if (cur.size === 0) delete next[col];
      else next[col] = cur;
      return next;
    });
  };

  const clearFacet = (col: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      delete next[col];
      return next;
    });
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setQuery(input.trim());
    setSelected({});
  };

  const activeFilterCount = selectedParam.length;
  const topColumns = HIGHLIGHT_KEYS.filter((k) => data?.facets.some((f) => f.column === k));
  const otherColumns = (data?.facets ?? []).map((f) => f.column).filter((k) => !topColumns.includes(k));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Deep search</h1>
        <p className="muted text-sm mt-1">
          Searches inside every column of your imported data. Filters below are built automatically from the
          columns your inventory actually has.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <FileSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search all columns — e.g. brand, color, graphic, era, size, price…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="muted">In</span>
          <select
            className="input max-w-xs"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setSelected({});
            }}
          >
            <option value="">All inventories</option>
            {inventories.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.itemCount} items)
              </option>
            ))}
          </select>
          {query && (
            <button type="button" className="btn-ghost text-xs" onClick={() => { setInput(""); setQuery(""); setSelected({}); }}>
              <X size={13} /> Clear query
            </button>
          )}
          {activeFilterCount > 0 && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setSelected({})}>
              <X size={13} /> Clear {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="rounded-lg bg-red-50 text-red-700 text-sm px-4 py-3">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 items-start">
        {/* Facets discovered from the data */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal size={14} /> Filters
            <span className="badge-slate text-[10px]">auto from data</span>
          </div>
          {!data && <p className="muted text-xs">Loading filters…</p>}
          {data && data.facets.length === 0 && (
            <p className="muted text-xs">No categorical columns found in this data.</p>
          )}
          {data?.facets.map((facet) => {
            const isTop = topColumns.includes(facet.column);
            const show = isTop || showAllColumns || expanded[facet.column];
            if (!show) return null;
            const sel = selected[facet.column];
            return (
              <div key={facet.column} className="card p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold">{facet.column}</span>
                  {sel && sel.size > 0 && (
                    <button className="text-[10px] muted underline" onClick={() => clearFacet(facet.column)}>
                      reset
                    </button>
                  )}
                </div>
                <div className="space-y-1 max-h-44 overflow-y-auto">
                  {facet.values.map(({ value, count }) => {
                    const checked = sel?.has(value) ?? false;
                    return (
                      <label key={value} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="accent-indigo-600 w-3.5 h-3.5"
                          checked={checked}
                          onChange={() => toggleFacet(facet.column, value)}
                        />
                        <span className={checked ? "font-medium" : ""}>{value}</span>
                        <span className="muted ml-auto">{count}</span>
                      </label>
                    );
                  })}
                </div>
                {facet.values.length >= 30 && (
                  <p className="text-[10px] muted mt-1">top {facet.values.length} values</p>
                )}
              </div>
            );
          })}
          {data && otherColumns.length > 0 && (
            <button className="btn-ghost text-xs w-full" onClick={() => setShowAllColumns((v) => !v)}>
              {showAllColumns ? "Hide more filters" : `Show ${otherColumns.length} more filter columns`}
            </button>
          )}
        </div>

        {/* Results */}
        <div className="space-y-3">
          {data && (
            <div className="text-sm muted">
              {busy ? "Searching…" : `${data.total} item${data.total === 1 ? "" : "s"} match`}
              {data.searchedColumns.length > 0 && ` · searching ${data.searchedColumns.length} columns`}
            </div>
          )}
          {data && data.items.length === 0 && (
            <div className="card p-10 text-center">
              <ImageIcon size={36} className="mx-auto text-slate-300 mb-3" />
              <p className="font-medium">No items match</p>
              <p className="muted text-sm mt-1">Try removing a filter or shortening the query.</p>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {data?.items.map((it) => (
              <ItemCard key={it.id} item={it} onOpen={() => setOpenItem(it)} />
            ))}
          </div>
        </div>
      </div>

      {openItem && <ProductDrawer item={openItem} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

function displayNameOf(item: SearchItem): string {
  return (
    item.name ||
    item.attributes["Product Name"] ||
    item.sku ||
    item.attributes["Sr. No."] ||
    "Unnamed item"
  );
}

function ItemCard({ item, onOpen }: { item: SearchItem; onOpen: () => void }) {
  const entries = Object.entries(item.attributes).filter(([, v]) => v && v.trim() !== "");
  const displayName = displayNameOf(item);
  const highlight = entries.filter(([k]) => HIGHLIGHT_KEYS.includes(k)).slice(0, 4);
  const extra = entries.filter(([k]) => !HIGHLIGHT_KEYS.includes(k)).slice(0, 2);
  const shown = [...highlight, ...extra];
  return (
    <button type="button" onClick={onOpen} className="card card-hover p-3 flex flex-col gap-2 text-left w-full">
      <div className="aspect-square rounded-lg border bg-white flex items-center justify-center overflow-hidden">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt={displayName} className="w-full h-full object-contain" />
        ) : (
          <ImageIcon size={28} className="text-slate-300" />
        )}
      </div>
      <div className="text-sm font-medium truncate" title={displayName}>{displayName}</div>
      <div className="space-y-0.5 text-[11px]">
        {shown.map(([k, v]) => (
          <div key={k} className="flex gap-1.5">
            <span className="muted shrink-0 max-w-[45%] truncate">{k}</span>
            <span className="truncate">{v}</span>
          </div>
        ))}
      </div>
      {item.inventoryName && <div className="text-[10px] muted mt-auto">{item.inventoryName}</div>}
    </button>
  );
}

function ProductDrawer({ item, onClose }: { item: SearchItem; onClose: () => void }) {
  const entries = Object.entries(item.attributes);
  const displayName = displayNameOf(item);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <div
        className="relative bg-white w-full max-w-md h-full shadow-xl overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">{displayName}</h3>
            <p className="text-xs muted mt-0.5">
              {item.sku ?? "no SKU"}
              {item.inventoryName ? ` · ${item.inventoryName}` : ""}
            </p>
          </div>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={displayName}
            className="w-full rounded-xl border mb-5 bg-slate-50 object-contain max-h-80"
          />
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
