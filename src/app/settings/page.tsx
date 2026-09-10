"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2, CheckCircle2, ShieldCheck, ExternalLink, Link2 } from "lucide-react";

interface Credential {
  provider: string;
  keyHint: string;
  meta: { mode?: string; clientId?: string } | null;
  updatedAt: string;
}

const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    help: "Powers the vision re-rank pass (gpt-4o-mini). Get a key at platform.openai.com.",
  },
  {
    id: "google",
    label: "Google (Sheets / Drive)",
    placeholder: "Google Cloud API key",
    help: "Used by the Google Sheets/Drive import. For private files, connect an OAuth app (Client ID + Secret) or paste a service-account JSON key — share the sheet/folder with the service account's email so it can read it.",
  },
  {
    id: "gemini",
    label: "Google Gemini (AI Studio)",
    placeholder: "AIza…",
    help: "Dedicated Gemini API key for the vision re-rank pass (gemini-1.5-flash). Get one free at aistudio.google.com — this key cannot read Sheets/Drive.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    placeholder: "sk-ant-…",
    help: "Alternative provider for the vision re-rank pass.",
  },
];

const GOOGLE_MODES = [
  { v: "api_key", l: "API key (public files)" },
  { v: "oauth_app", l: "OAuth app — Client ID + Secret (recommended)" },
  { v: "service_account", l: "Service account (JSON key)" },
  { v: "oauth", l: "Raw access token (legacy)" },
];

export default function SettingsPage() {
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { key: string; mode: string; clientId: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/credentials");
    const json = await res.json();
    setCreds(json.credentials ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Status flag from the OAuth callback redirect (?google=connected|error&message=…)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    if (g === "connected") setBanner({ ok: true, text: "Google Drive connected — the import can now read your Sheets and folders." });
    else if (g === "error")
      setBanner({ ok: false, text: `Google authorization failed: ${params.get("message") ?? "unknown error"}` });
    else return;
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const draft = (id: string) => drafts[id] ?? { key: "", mode: "api_key", clientId: "" };

  const save = async (provider: string) => {
    const d = draft(provider);
    if (!d.key) return;
    setBusy(provider);
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          provider === "google" && d.mode === "oauth_app"
            ? { provider, mode: d.mode, clientId: d.clientId, key: d.key }
            : { provider, key: d.key, mode: d.mode }
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      if (json.next === "authorize") {
        setMessages((m) => ({
          ...m,
          [provider]: { ok: true, text: "Client saved (encrypted at rest). Now click \"Authorize with Google\" to connect." },
        }));
      } else {
        setMessages((m) => ({
          ...m,
          [provider]: { ok: true, text: json.warning ?? "Validated and saved (encrypted at rest)." },
        }));
      }
      setDrafts((ds) => ({ ...ds, [provider]: { key: "", mode: ds[provider]?.mode ?? "api_key", clientId: ds[provider]?.clientId ?? "" } }));
      await load();
    } catch (e) {
      setMessages((m) => ({ ...m, [provider]: { ok: false, text: e instanceof Error ? e.message : "Save failed" } }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: string) => {
    await fetch(`/api/settings/credentials?provider=${provider}`, { method: "DELETE" });
    await load();
  };

  const oauthApp = creds?.find((c) => c.provider === "google_oauth_app");
  const oauthToken = creds?.find((c) => c.provider === "google_oauth_token");
  const serviceAccount = creds?.find((c) => c.provider === "google_service_account");

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="muted text-sm mt-1 flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-emerald-600" />
          Keys are validated, then encrypted (AES-256-GCM) before storage — never logged, never sent to the client.
        </p>
      </header>

      {banner && (
        <div className={`rounded-lg px-4 py-3 text-sm ${banner.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {banner.text}
          <button className="ml-3 underline" onClick={() => setBanner(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="space-y-4">
        {PROVIDERS.map((p) => {
          const saved = creds?.find((c) => c.provider === p.id);
          const d = draft(p.id);
          const msg = messages[p.id];
          const isGoogle = p.id === "google";
          return (
            <div key={p.id} className="card p-6">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2.5">
                  <KeyRound size={16} className="text-indigo-500" />
                  <h3 className="font-medium">{p.label}</h3>
                </div>
                {isGoogle && (oauthToken || serviceAccount) ? (
                  <span className="badge-green">
                    <CheckCircle2 size={12} /> Google Drive connected
                    {serviceAccount && !oauthToken ? ` · ${serviceAccount.keyHint}` : ""}
                  </span>
                ) : (
                  saved && (
                    <span className="badge-green">
                      <CheckCircle2 size={12} /> {saved.keyHint}
                      {saved.meta?.mode ? ` · ${saved.meta.mode === "oauth" ? "oauth token" : "api key"}` : ""}
                    </span>
                  )
                )}
              </div>
              <p className="text-xs muted mb-4">{p.help}</p>

              {isGoogle && (
                <>
                  <div className="mb-3">
                    <label className="label">Credential type</label>
                    <div className="inline-flex flex-wrap gap-1.5 p-1 rounded-xl bg-slate-100/80 border border-slate-200/70">
                      {GOOGLE_MODES.map((o) => (
                        <button
                          key={o.v}
                          className={`text-xs px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-all duration-200 ${
                            d.mode === o.v
                              ? "text-white shadow-md"
                              : "text-slate-600 hover:text-slate-900 hover:bg-white/70"
                          }`}
                          style={
                            d.mode === o.v
                              ? {
                                  background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
                                  boxShadow: "0 2px 8px rgba(99, 102, 241, 0.4)",
                                }
                              : undefined
                          }
                          onClick={() => setDrafts((ds) => ({ ...ds, [p.id]: { ...d, mode: o.v } }))}
                        >
                          {o.l}
                        </button>
                      ))}
                    </div>
                  </div>

                  {d.mode === "oauth_app" && (
                    <div className="mb-4 rounded-lg bg-slate-50 border border-slate-100 p-4 space-y-3">
                      <div>
                        <label className="label">Client ID</label>
                        <input
                          className="input font-mono text-xs"
                          autoComplete="off"
                          placeholder="1234567890-abcdef.apps.googleusercontent.com"
                          value={d.clientId}
                          onChange={(e) => setDrafts((ds) => ({ ...ds, [p.id]: { ...d, clientId: e.target.value } }))}
                        />
                      </div>
                      <div>
                        <label className="label">Client Secret</label>
                        <input
                          className="input font-mono"
                          type="password"
                          autoComplete="off"
                          placeholder="GOCSPX-…"
                          value={d.key}
                          onChange={(e) => setDrafts((ds) => ({ ...ds, [p.id]: { ...d, key: e.target.value } }))}
                        />
                      </div>
                      <p className="text-xs muted">
                        In Google Cloud Console → APIs &amp; Services → Credentials, create an <b>OAuth client ID</b> (Web
                        application) and add this exact redirect URI:
                        <code className="ml-1 px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                          {typeof window !== "undefined" ? `${window.location.origin}/api/settings/google/callback` : "/api/settings/google/callback"}
                        </code>
                        . Scopes requested are read-only (Sheets + Drive).
                      </p>
                    </div>
                  )}

                  {oauthApp && (
                    <div className="mb-4 flex items-center justify-between rounded-lg bg-indigo-50 border border-indigo-100 px-4 py-3">
                      <div className="text-xs">
                        <div className="font-medium text-indigo-700 flex items-center gap-1.5">
                          <Link2 size={12} /> OAuth client saved — {oauthApp.keyHint}
                        </div>
                        <div className="text-indigo-600/80 mt-0.5">
                          {oauthToken
                            ? "Connection is live; tokens refresh automatically."
                            : "Next step: authorize this app to read your Google files."}
                        </div>
                      </div>
                      <a className="btn-primary text-xs whitespace-nowrap flex items-center gap-1.5" href="/api/settings/google/authorize">
                        <ExternalLink size={12} /> {oauthToken ? "Re-authorize" : "Authorize with Google"}
                      </a>
                    </div>
                  )}
                </>
              )}

              {isGoogle && d.mode === "service_account" ? (
                <textarea
                  className="input font-mono text-xs min-h-32"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`Paste the whole service-account JSON key file here, e.g.\n{\n  "type": "service_account",\n  "project_id": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\n…",\n  "client_email": "…@….iam.gserviceaccount.com",\n  …\n}`}
                  value={d.key}
                  onChange={(e) => setDrafts((ds) => ({ ...ds, [p.id]: { ...d, key: e.target.value } }))}
                />
              ) : (
                <input
                  className="input font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    isGoogle && d.mode === "oauth_app"
                      ? oauthApp
                        ? "Replace Client Secret…"
                        : "Client Secret"
                      : saved
                        ? "Replace key…"
                        : p.placeholder
                  }
                  value={d.key}
                  onChange={(e) => setDrafts((ds) => ({ ...ds, [p.id]: { ...d, key: e.target.value } }))}
                />
              )}
              <div className="flex gap-2">
                <button
                  className="btn-primary whitespace-nowrap"
                  disabled={!d.key || busy === p.id}
                  onClick={() => void save(p.id)}
                >
                  {busy === p.id ? "Validating…" : isGoogle && d.mode === "oauth_app" ? "Save client" : "Validate & save"}
                </button>
                {(saved || (isGoogle && (oauthApp || oauthToken || serviceAccount))) && (
                  <button className="btn-danger !px-3" title="Remove credential" onClick={() => void remove(p.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {msg && <div className={`text-xs mt-2 ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</div>}
            </div>
          );
        })}
      </div>

      <div className="card p-6">
        <h3 className="font-medium mb-2">Match threshold</h3>
        <p className="text-xs muted mb-3">
          Defaults to 70% (settable via the MATCH_THRESHOLD env var). Results below the threshold always show the top 3
          candidates for manual confirmation instead of a single verdict.
        </p>
        <div className="h-2 rounded-full bg-slate-100 max-w-xs">
          <div className="h-2 rounded-full w-[70%]" style={{ background: "var(--accent)" }} />
        </div>
      </div>
    </div>
  );
}
