"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, FileSpreadsheet, FileText, Globe, Plus, RefreshCw, Trash2 } from "lucide-react";

interface InventoryRow {
  id: string;
  name: string;
  sourceType: string;
  lastSyncedAt: string | null;
  itemCount: number;
  embeddings: { items: number; withImages: number; embedded: number };
}

interface PreviewResponse {
  stashId: string;
  sourceType: string;
  inventoryName: string;
  columns: string[];
  totalRows: number;
  sampleRows: Record<string, string>[];
  imageCount: number;
  warning?: string;
  suggestedMapping: { sku?: string; name?: string; category?: string; image?: string };
}

export default function InventoriesPage() {
  const [inventories, setInventories] = useState<InventoryRow[] | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    // sidebar deep-link (?import=1) — avoids useSearchParams/Suspense constraint
    if (new URLSearchParams(window.location.search).get("import") === "1") setWizardOpen(true);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/inventories");
    const json = await res.json();
    setInventories(json.inventories ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventories</h1>
          <p className="muted text-sm mt-1">Synced copies of your sources — originals are never modified.</p>
        </div>
        <button className="btn-primary" onClick={() => setWizardOpen((v) => !v)}>
          <Plus size={16} /> Import inventory
        </button>
      </header>

      {wizardOpen && (
        <ImportWizard
          onDone={() => {
            setWizardOpen(false);
            void load();
          }}
        />
      )}

      {inventories === null ? (
        <LoadingGrid />
      ) : inventories.length === 0 ? (
        <div className="card p-12 text-center">
          <Box className="mx-auto mb-4 text-slate-300" size={48} />
          <h3 className="font-medium">No inventories yet</h3>
          <p className="muted text-sm mt-1 mb-6">Import an Excel or Word file, or paste a Google Sheets/Drive link to get started.</p>
          <button className="btn-primary mx-auto" onClick={() => setWizardOpen(true)}>
            <Plus size={16} /> Import your first inventory
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {inventories.map((inv) => (
            <div key={inv.id} className="card card-hover p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <SourceIcon type={inv.sourceType} />
                  <div>
                    <Link href={`/inventories/${inv.id}`} className="font-medium hover:underline">
                      {inv.name}
                    </Link>
                    <div className="text-xs muted">{inv.itemCount} items</div>
                  </div>
                </div>
                <SyncBadge embeddings={inv.embeddings} />
              </div>
              <div className="text-xs muted">
                {inv.embeddings.embedded}/{inv.embeddings.withImages} images embedded
                {inv.lastSyncedAt ? ` · synced ${new Date(inv.lastSyncedAt).toLocaleString()}` : ""}
              </div>
              <div className="flex items-center gap-2 mt-auto pt-2">
                <Link href={`/inventories/${inv.id}`} className="btn-ghost !py-1.5 text-xs">
                  View items
                </Link>
                <button
                  className="btn-danger !py-1.5 text-xs ml-auto"
                  onClick={async () => {
                    if (!confirm(`Delete synced copy "${inv.name}"? The original file is not touched.`)) return;
                    await fetch(`/api/inventories/${inv.id}`, { method: "DELETE" });
                    void load();
                  }}
                >
                  <Trash2 size={13} /> Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportWizard({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [inventoryName, setInventoryName] = useState("");
  const [mapping, setMapping] = useState<PreviewResponse["suggestedMapping"]>({});
  const [committing, setCommitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const runParse = async (payload: { file?: File; url?: string }) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const form = new FormData();
      if (payload.file) form.set("file", payload.file);
      if (payload.url) {
        form.set("url", payload.url);
        form.set("kind", "auto");
      }
      const res = await fetch("/api/import/parse", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Parse failed");
      setPreview(json);
      setInventoryName(json.inventoryName);
      setMapping(json.suggestedMapping ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stashId: preview.stashId, inventoryName, mapping }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Commit failed");
      onDone();
      router.push(`/inventories/${json.inventoryId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
      setCommitting(false);
    }
  };

  return (
    <div className="card p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Import a source</h2>
        <span className="badge-slate">read-only — your file is never modified</span>
      </div>

      {!preview && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) {
                setFile(f);
                void runParse({ file: f });
              }
            }}
          >
            <FileSpreadsheet className="mx-auto mb-3 text-indigo-400" size={32} />
            <p className="text-sm font-medium">Drop an .xlsx or .docx file</p>
            <p className="text-xs muted mt-1">{file ? file.name : "or click to browse — max 100MB"}</p>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.docx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  void runParse({ file: f });
                }
              }}
            />
          </div>
          <div className="border-2 border-dashed rounded-xl p-8 flex flex-col justify-center">
            <Globe className="mb-3 text-indigo-400" size={28} />
            <label className="label">Google Sheets or Drive folder link</label>
            <div className="flex gap-2">
              <input
                className="input"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button className="btn-primary whitespace-nowrap" disabled={!url || busy} onClick={() => void runParse({ url })}>
                Connect
              </button>
            </div>
            <p className="text-xs muted mt-2">Requires a Google credential on the Settings page (API key for public files).</p>
          </div>
        </div>
      )}

      {busy && <BusyRow label={preview ? "Committing…" : "Parsing source and detecting images…"} />}

      {error && <div className="rounded-lg bg-red-50 text-red-700 text-sm px-4 py-3">{error}</div>}

      {preview && !busy && (
        <div className="space-y-5">
          <div className="flex items-center gap-4 text-sm">
            <span className="badge-green">{preview.sourceType.toUpperCase()} detected</span>
            <span>{preview.totalRows} rows</span>
            <span>{preview.imageCount} embedded images</span>
            <span className="muted">{preview.columns.length} columns</span>
          </div>

          {preview.warning && (
            <div className="rounded-lg bg-amber-50 text-amber-800 text-sm px-4 py-3">{preview.warning}</div>
          )}

          <div>
            <label className="label">Inventory name</label>
            <input className="input max-w-md" value={inventoryName} onChange={(e) => setInventoryName(e.target.value)} />
          </div>

          <div>
            <div className="label">Column mapping (from your file&apos;s original headers)</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(["sku", "name", "category", "image"] as const).map((field) => (
                <div key={field}>
                  <label className="label !normal-case !text-slate-500">{field} column</label>
                  <select
                    className="input"
                    value={mapping[field] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                  >
                    <option value="">— none —</option>
                    {preview.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="label">Sample rows (all original columns preserved)</div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="text-xs w-full">
                <thead className="bg-slate-50">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((row, i) => (
                    <tr key={i} className="border-t">
                      {preview.columns.map((c) => (
                        <td key={c} className="px-3 py-2 max-w-40 truncate whitespace-nowrap">
                          {row[c] || <span className="text-slate-300">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn-primary" disabled={committing} onClick={() => void commit()}>
              {committing ? "Importing…" : "Confirm & import"}
            </button>
            <button className="btn-ghost" onClick={() => setPreview(null)}>
              Start over
            </button>
            <span className="text-xs muted">Embeddings generate automatically after import.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceIcon({ type }: { type: string }) {
  const cls = "text-indigo-500";
  if (type === "docx") return <FileText className={cls} size={22} />;
  if (type === "gsheet" || type === "gdrive") return <Globe className={cls} size={22} />;
  return <FileSpreadsheet className={cls} size={22} />;
}

function SyncBadge({ embeddings }: { embeddings: InventoryRow["embeddings"] }) {
  if (embeddings.withImages === 0) return <span className="badge-slate">no images</span>;
  if (embeddings.embedded >= embeddings.withImages) return <span className="badge-green">ready</span>;
  return (
    <span className="badge-amber">
      <RefreshCw size={11} className="animate-spin" /> embedding…
    </span>
  );
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="card p-5 animate-pulse space-y-3">
          <div className="h-5 bg-slate-100 rounded w-1/2" />
          <div className="h-3 bg-slate-100 rounded w-1/3" />
          <div className="h-3 bg-slate-100 rounded w-2/3" />
        </div>
      ))}
    </div>
  );
}

function BusyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-600 px-1">
      <RefreshCw size={16} className="animate-spin text-indigo-500" /> {label}
    </div>
  );
}
