import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { encryptSecret, keyHint } from "@/lib/crypto";
import { saveGoogleClient, saveGoogleServiceAccount, deleteGoogleConnection } from "@/lib/google-auth";

const ALLOWED_PROVIDERS = ["openai", "google", "gemini", "anthropic"] as const;

// GET: list providers with hints only — never key material.
export async function GET() {
  const creds = await prisma.apiCredential.findMany();
  return NextResponse.json({
    credentials: creds.map((c) => ({
      provider: c.provider,
      keyHint: c.keyHint,
      meta: c.meta ? JSON.parse(c.meta) : null,
      updatedAt: c.updatedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { provider?: string; key?: string; mode?: string; clientId?: string };
  const provider = body.provider?.toLowerCase();
  const key = body.key?.trim();

  if (!provider || !ALLOWED_PROVIDERS.includes(provider as (typeof ALLOWED_PROVIDERS)[number])) {
    return NextResponse.json({ error: `provider must be one of ${ALLOWED_PROVIDERS.join(", ")}` }, { status: 400 });
  }
  if (!key || key.length < 8) return NextResponse.json({ error: "key is required" }, { status: 400 });

  // Google OAuth app mode stores a Client ID + Secret pair (no API call to
  // validate — real validation happens during the consent redirect).
  if (provider === "google" && body.mode === "oauth_app") {
    const clientId = body.clientId?.trim() ?? "";
    if (!clientId || !clientId.endsWith(".apps.googleusercontent.com")) {
      return NextResponse.json(
        { error: "Enter the Client ID from Google Cloud Console (looks like 1234-abc.apps.googleusercontent.com)." },
        { status: 400 }
      );
    }
    if (key.length < 16) {
      return NextResponse.json({ error: "That doesn't look like a Client Secret (too short)." }, { status: 400 });
    }
    await saveGoogleClient(clientId, key);
    return NextResponse.json({
      ok: true,
      next: "authorize",
      credential: { provider: "google_oauth_app", keyHint: keyHint(clientId), meta: { mode: "oauth_app", clientId } },
    });
  }

  // Service account mode: the "key" is the whole downloaded JSON key file.
  // Validated by actually minting an access token and reading the Drive profile.
  if (provider === "google" && body.mode === "service_account") {
    let clientEmail: string;
    try {
      const parsed = await saveGoogleServiceAccount(key);
      clientEmail = parsed.clientEmail;
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid service-account key." }, { status: 400 });
    }
    try {
      const { getServiceAccountAccessToken } = await import("@/lib/google-auth");
      const token = await getServiceAccountAccessToken();
      if (!token) throw new Error("could not mint an access token from the key");
      // Auth check against the Sheets API (a bogus sheet id returning 404
      // proves the token was accepted). Drive is probed separately so Sheets
      // imports work even when the project hasn't enabled the Drive API yet.
      const sheetsProbe = await fetch("https://sheets.googleapis.com/v4/spreadsheets/invalid_id_test", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!(sheetsProbe.ok || sheetsProbe.status === 404)) {
        await prisma.apiCredential.deleteMany({ where: { provider: "google_service_account" } });
        return NextResponse.json(
          {
            error:
              sheetsProbe.status === 401
                ? "Google rejected the service account key (HTTP 401). Is the key disabled or deleted?"
                : `Google rejected the service account (HTTP ${sheetsProbe.status}).`,
          },
          { status: 400 }
        );
      }
      const driveProbe = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (driveProbe.status === 403) {
        // Non-fatal: Sheets imports still work; flag the disabled Drive API.
        const body = (await driveProbe.json().catch(() => ({}))) as {
          error?: { details?: { metadata?: { activationUrl?: string } }[] };
        };
        const activationUrl = body.error?.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
        return NextResponse.json({
          ok: true,
          warning: `Saved — but the Drive API is not enabled for your Google project, so Drive folder imports will fail until you enable it.${
            activationUrl ? ` Enable it here: ${activationUrl}` : ""
          } Google Sheets imports work right now.`,
          credential: {
            provider: "google_service_account",
            keyHint: clientEmail,
            meta: { mode: "service_account", clientEmail },
          },
        });
      }
    } catch {
      await prisma.apiCredential.deleteMany({ where: { provider: "google_service_account" } });
      return NextResponse.json(
        { error: "Could not exchange the service-account key for an access token. Is the key disabled or deleted?" },
        { status: 400 }
      );
    }
    return NextResponse.json({
      ok: true,
      credential: {
        provider: "google_service_account",
        keyHint: clientEmail,
        meta: { mode: "service_account", clientEmail },
      },
    });
  }

  // Lightweight validation call BEFORE saving — spend one cheap request.
  const validation = await validateKey(provider, key, body.mode);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error ?? "Key validation failed — not saved." }, { status: 400 });
  }

  const encrypted = encryptSecret(key);
  const meta = provider === "google" ? JSON.stringify({ mode: body.mode === "oauth" ? "oauth" : "api_key" }) : null;

  const cred = await prisma.apiCredential.upsert({
    where: { provider },
    update: { encryptedKey: encrypted, keyHint: keyHint(key), ...(meta ? { meta } : {}) },
    create: { provider, encryptedKey: encrypted, keyHint: keyHint(key), meta },
  });

  return NextResponse.json({
    ok: true,
    credential: { provider: cred.provider, keyHint: cred.keyHint, meta: cred.meta ? JSON.parse(cred.meta) : null },
  });
}

export async function DELETE(req: NextRequest) {
  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider) return NextResponse.json({ error: "provider query param required" }, { status: 400 });
  if (provider === "google") {
    // clears the legacy key, the OAuth client, and the token connection
    await deleteGoogleConnection();
    return NextResponse.json({ ok: true });
  }
  await prisma.apiCredential.deleteMany({ where: { provider } });
  return NextResponse.json({ ok: true });
}

async function validateKey(
  provider: string,
  key: string,
  mode?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${key}` },
      });
      return res.ok ? { ok: true } : { ok: false, error: `OpenAI rejected the key (HTTP ${res.status}).` };
    }
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      return res.ok ? { ok: true } : { ok: false, error: `Anthropic rejected the key (HTTP ${res.status}).` };
    }
    if (provider === "google") {
      const isOauth = mode === "oauth";
      const res = isOauth
        ? await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
            headers: { Authorization: `Bearer ${key}` },
          })
        : await fetch("https://sheets.googleapis.com/v4/spreadsheets/invalid_id_test?key=" + encodeURIComponent(key));
      // A key that reaches Google and gets a well-formed auth response is alive;
      // 403/401 means bad key, 404 on the bogus sheet id means auth passed.
      if (res.status === 404) return { ok: true };
      if (res.ok) return { ok: true };
      if (res.status === 403 || res.status === 401) {
        return {
          ok: false,
          error:
            "This credential cannot read Google Sheets/Drive (HTTP " +
            res.status +
            "). Use a Google Cloud API key (public files), or switch this card to \"OAuth app (Client ID + Secret)\" and click Authorize — a raw Client Secret is not an access token, and a Gemini (AI Studio) key belongs in the separate Gemini card below.",
        };
      }
      return { ok: false, error: `Google rejected the credential (HTTP ${res.status}).` };
    }
    if (provider === "gemini") {
      // AI Studio keys are scoped to the Generative Language API — validate there,
      // not against Sheets/Drive (which rejects them with 403).
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=" + encodeURIComponent(key)
      );
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 403)
        return { ok: false, error: `Gemini rejected the API key (HTTP ${res.status}). Check it's an AI Studio key (starts with AIza…).` };
      return { ok: false, error: `Gemini rejected the API key (HTTP ${res.status}).` };
    }
    return { ok: false, error: "unsupported provider" };
  } catch {
    return { ok: false, error: "Could not reach the provider to validate the key." };
  }
}
