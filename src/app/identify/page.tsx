"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScanSearch, Upload, Check, X, Sparkles, AlertTriangle, ChevronLeft } from "lucide-react";

interface Candidate {
  itemId: string;
  score: number;
  imageUrl: string;
  item: {
    id: string;
    sku: string | null;
    name: string | null;
    category: string | null;
    attributes: Record<string, string>;
    hasImage: boolean;
    imageUrl: string | null;
    imageOriginalFilename: string | null;
  };
}

interface IdentifyResponse {
  queryId: string;
  confident: boolean;
  exactMatch?: boolean;
  threshold: number;
  confidence: number;
  vectorModel: string;
  rerank: { bestItemId: string | null; reason: string } | null;
  requiresConfirmation: boolean;
  candidates: Candidate[];
  uploadedPreview: string;
}

interface InventoryOption {
  id: string;
  name: string;
}

export default function IdentifyPage() {
  const [inventories, setInventories] = useState<InventoryOption[]>([]);
  const [scope, setScope] = useState("");
  const [rerank, setRerank] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<IdentifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [confirmedItem, setConfirmedItem] = useState<Candidate | null>(null);
  const [rejected, setRejected] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const resetSearch = useCallback(() => {
    setResult(null);
    setPreview(null);
    setError(null);
    setConfirmedId(null);
    setConfirmedItem(null);
    setRejected(false);
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/inventories");
      const json = await res.json();
      setInventories(json.inventories ?? []);
    })();
  }, []);

  const identify = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setResult(null);
      setConfirmedId(null);
      setRejected(false);
      setPreview(URL.createObjectURL(file));
      try {
        const form = new FormData();
        form.set("image", file);
        if (scope) form.set("inventoryId", scope);
        form.set("rerank", String(rerank));
        const res = await fetch("/api/identify", { method: "POST", body: form });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Identify failed");
        setResult(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Identify failed");
      } finally {
        setBusy(false);
      }
    },
    [scope, rerank]
  );

  const confirm = async (itemId: string | null) => {
    if (!result) return;
    const res = await fetch(`/api/identify/${result.queryId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    if (!res.ok) return;
    if (itemId === null) {
      // "None of these" — rejection is logged; start a fresh search.
      resetSearch();
      return;
    }
    // "Confirm match" — show the full record for the confirmed item.
    setConfirmedId(itemId);
    setRejected(false);
    setConfirmedItem(result.candidates.find((c) => c.itemId === itemId) ?? null);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Identify an item</h1>
        <p className="muted text-sm mt-1">
          Upload or paste a photo — results always carry a confidence score; below the threshold you get the top 3 candidates.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end max-w-3xl">
        <div>
          <label className="label">Scope</label>
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All inventories</option>
            {inventories.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm select-none cursor-pointer h-10">
          <input type="checkbox" className="accent-indigo-600 w-4 h-4" checked={rerank} onChange={(e) => setRerank(e.target.checked)} />
          <Sparkles size={14} className="text-indigo-500" />
          Vision re-rank pass (uses your API key)
        </label>
      </div>

      {!result && (
        <div
          className={`card p-12 text-center cursor-pointer transition-colors border-2 ${
            dragOver ? "border-indigo-400 bg-indigo-50/50" : "border-dashed"
          }`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void identify(f);
          }}
          onPaste={(e) => {
            const f = e.clipboardData.files?.[0];
            if (f) void identify(f);
          }}
          tabIndex={0}
        >
          {busy ? (
            <>
              <ScanSearch size={44} className="mx-auto text-indigo-500 animate-pulse mb-4" />
              <p className="font-medium">Matching against catalog…</p>
              <p className="muted text-sm mt-1">embedding photo → vector search{rerank ? " → vision re-rank" : ""}</p>
            </>
          ) : (
            <>
              <Upload size={44} className="mx-auto text-slate-300 mb-4" />
              <p className="font-medium">Drop a photo here, click to browse, or paste from clipboard</p>
              <p className="muted text-sm mt-1">JPG/PNG, max 10MB</p>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void identify(f);
            }}
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 text-red-700 text-sm px-4 py-3 flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {result && confirmedItem && (
        <ConfirmedLarge
          candidate={confirmedItem}
          onNewSearch={resetSearch}
          onBack={() => {
            setConfirmedItem(null);
            setConfirmedId(null);
          }}
        />
      )}

      {result && !confirmedItem && (
        <div className="space-y-6">
          <button className="btn-ghost text-xs" onClick={resetSearch}>
            <ChevronLeft size={14} /> New search
          </button>

          {/* Verdict banner — exact bytes say 100%; vision re-rank says verified;
              otherwise it's a probabilistic score and never claims certainty */}
          <div
            className={`rounded-xl px-5 py-4 flex items-start gap-3 ${
              result.confident ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
            }`}
          >
            {result.confident ? <Check size={18} className="mt-0.5" /> : <AlertTriangle size={18} className="mt-0.5" />}
            <div>
              <div className="font-medium">
                {result.exactMatch
                  ? "Exact match found — 100% (byte-identical catalog image)"
                  : result.confident
                    ? `Likely match found — ${(result.confidence * 100).toFixed(1)}% confidence${result.rerank?.bestItemId ? " · vision-verified" : ""}`
                    : `Below ${result.threshold * 100}% confidence — showing top ${result.candidates.length} candidates`}
              </div>
              <div className="text-sm mt-0.5 opacity-80">
                {result.rerank
                  ? `Vision re-rank: ${result.rerank.reason}`
                  : "Similarity is computed from image features — always verify visually before acting on a match."}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* Uploaded photo */}
            <div className="card p-5">
              <div className="label">Your photo</div>
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="uploaded" className="w-full rounded-lg border object-contain max-h-96 bg-slate-50" />
              )}
            </div>

            {/* Top candidate, original bytes */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="label !mb-0">Best catalog match</div>
                <div className="flex items-center gap-2">
                  <span className="badge-slate">original image</span>
                  {confirmedId === result.candidates[0]?.itemId && <span className="badge-green">confirmed</span>}
                  {rejected && <span className="badge-amber">rejected</span>}
                </div>
              </div>
              {result.candidates[0] ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={result.candidates[0].item.imageUrl ?? result.candidates[0].imageUrl}
                    alt={result.candidates[0].item.name ?? "match"}
                    className="w-full rounded-lg border object-contain max-h-96 bg-white"
                  />
                  <MetaPanel candidate={result.candidates[0]} score={result.candidates[0].score} />
                  <div className="flex gap-2 mt-4">
                    <button className="btn-primary text-xs" onClick={() => void confirm(result.candidates[0].itemId)}>
                      <Check size={14} /> Confirm match
                    </button>
                    <button className="btn-danger text-xs" onClick={() => void confirm(null)}>
                      <X size={14} /> None of these
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted text-sm">No candidates.</p>
              )}
            </div>
          </div>

          {/* Candidate list for low confidence */}
          {!result.confident && result.candidates.length > 1 && (
            <div>
              <h3 className="font-medium mb-3">Top candidates — pick the correct one</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {result.candidates.map((c, i) => (
                  <div key={c.itemId} className="card card-hover p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="badge-slate">#{i + 1}</span>
                      <span className="text-xs font-medium">{(c.score * 100).toFixed(1)}%</span>
                    </div>
                    {c.item.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.item.imageUrl} alt={c.item.name ?? "candidate"} className="w-full rounded-lg border object-contain max-h-56 bg-white mb-3" />
                    )}
                    <MetaPanel candidate={c} score={c.score} compact />
                    {confirmedId === c.itemId ? (
                      <div className="badge-green mt-3 w-full justify-center">confirmed</div>
                    ) : (
                      <button className="btn-ghost text-xs w-full mt-3" onClick={() => void confirm(c.itemId)}>
                        <Check size={14} /> This is the item
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] muted">
            Vector model: {result.vectorModel} · threshold {(result.threshold * 100).toFixed(0)}% · confirmations feed the
            accuracy feedback loop.
          </p>
        </div>
      )}
    </div>
  );
}

function ConfirmedLarge({
  candidate,
  onNewSearch,
  onBack,
}: {
  candidate: Candidate;
  onNewSearch: () => void;
  onBack: () => void;
}) {
  const { item } = candidate;
  const entries = Object.entries(item.attributes).filter(([k]) => k !== "__parsed_extra");
  const img = item.imageUrl ?? candidate.imageUrl;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-ghost text-xs" onClick={onBack}>
          <ChevronLeft size={14} /> Back to candidates
        </button>
        <button className="btn-primary text-xs" onClick={onNewSearch}>
          <ScanSearch size={14} /> New search
        </button>
      </div>

      <div className="rounded-xl px-5 py-4 flex items-start gap-3 bg-emerald-50 text-emerald-800">
        <Check size={18} className="mt-0.5" />
        <div>
          <div className="font-medium">Match confirmed</div>
          <div className="text-sm mt-0.5 opacity-80">
            Logged to the accuracy feedback loop — full record below.
          </div>
        </div>
      </div>

      <div className="card p-6 grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        <div>
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={img}
              alt={item.name ?? "confirmed item"}
              className="w-full rounded-xl border object-contain max-h-[34rem] bg-white"
            />
          ) : (
            <p className="muted text-sm">No image on file for this item.</p>
          )}
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight break-words">
            {item.name ?? item.sku ?? "Unnamed item"}
          </h2>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm muted">
            {item.sku && <span>SKU: {item.sku}</span>}
            {item.category && <span>· {item.category}</span>}
            <span className="badge-green">confirmed</span>
            <span className="badge-slate">{(candidate.score * 100).toFixed(1)}% similar</span>
          </div>
          <div className="divide-y rounded-xl border mt-4 text-sm">
            {entries.length === 0 && <div className="px-4 py-3 muted">No attributes recorded.</div>}
            {entries.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[1fr_1.5fr] gap-3 px-4 py-2.5">
                <span className="muted break-words">{k}</span>
                <span className="break-words font-medium">{v || "—"}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] muted mt-3">Values shown exactly as imported (attributes_json round-trip).</p>
        </div>
      </div>
    </div>
  );
}

function MetaPanel({ candidate, score, compact }: { candidate: Candidate; score: number; compact?: boolean }) {
  const { item } = candidate;
  const entries = Object.entries(item.attributes).filter(([k]) => k !== "__parsed_extra");
  const shown = compact ? entries.slice(0, 4) : entries;
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <div className="font-medium text-sm truncate">{item.name ?? item.sku ?? "Unnamed item"}</div>
        <span className="text-xs muted">{(score * 100).toFixed(1)}% similar</span>
      </div>
      {item.sku && <div className="text-xs muted">SKU: {item.sku}</div>}
      <div className="divide-y rounded-lg border mt-2 text-xs max-h-52 overflow-y-auto">
        {shown.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[1fr_1.5fr] gap-2 px-3 py-1.5">
            <span className="muted break-words">{k}</span>
            <span className="break-words">{v || "—"}</span>
          </div>
        ))}
        {!compact && entries.length === 0 && <div className="px-3 py-2 muted">No extra attributes.</div>}
      </div>
    </div>
  );
}
