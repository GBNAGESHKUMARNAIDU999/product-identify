import crypto from "crypto";
import { prisma } from "./db";
import { encryptSecret, decryptSecret, keyHint } from "./crypto";

// Google OAuth client flow ("oauth_app" mode). The user pastes an OAuth
// Client ID + Client Secret from Google Cloud Console (Web application type,
// redirect URI registered as <origin>/api/settings/google/callback). A consent
// popup exchanges the code for a refresh token, which is stored encrypted and
// refreshed automatically — no more expiring raw access tokens.
//
// Service account mode ("service_account"): the user pastes a downloaded
// service-account JSON key; access tokens are minted locally via the JWT
// bearer grant (RS256 signed with the key's private_key) and cached in memory
// until they expire.
//
// Storage layout in ApiCredential:
//   provider "google_oauth_app"   encryptedKey = client secret,
//                                 meta { mode: "oauth_app", clientId }
//   provider "google_oauth_token" encryptedKey = refresh token,
//                                 meta { mode: "oauth_token",
//                                        accessTokenEnc, expiresAt }
//   provider "google_service_account" encryptedKey = the full JSON key file,
//                                 meta { mode: "service_account", clientEmail }
// The legacy provider "google" (api_key / raw oauth access token) still works.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "email",
];

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export async function saveGoogleClient(clientId: string, clientSecret: string): Promise<void> {
  await prisma.apiCredential.upsert({
    where: { provider: "google_oauth_app" },
    update: {
      encryptedKey: encryptSecret(clientSecret),
      keyHint: keyHint(clientId),
      meta: JSON.stringify({ mode: "oauth_app", clientId }),
    },
    create: {
      provider: "google_oauth_app",
      encryptedKey: encryptSecret(clientSecret),
      keyHint: keyHint(clientId),
      meta: JSON.stringify({ mode: "oauth_app", clientId }),
    },
  });
}

export async function getGoogleClient(): Promise<GoogleClient | null> {
  const cred = await prisma.apiCredential.findUnique({ where: { provider: "google_oauth_app" } });
  if (!cred) return null;
  try {
    const meta = cred.meta ? (JSON.parse(cred.meta) as { clientId?: string }) : null;
    if (!meta?.clientId) return null;
    return { clientId: meta.clientId, clientSecret: decryptSecret(cred.encryptedKey) };
  } catch {
    return null;
  }
}

export async function deleteGoogleConnection(): Promise<void> {
  // Removing the Google credential clears every part of it.
  await prisma.apiCredential.deleteMany({
    where: { provider: { in: ["google", "google_oauth_app", "google_oauth_token", "google_service_account"] } },
  });
}

// --- Authorization redirect ---

export function buildAuthUrl(client: GoogleClient, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token, even on re-consent
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Single-instance CSRF state store; entries expire after 10 minutes.
const pendingStates = new Map<string, number>();
export function createState(): string {
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  for (const [k, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(k);
  return state;
}
export function consumeState(state: string): boolean {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return !!exp && exp >= Date.now();
}

// --- Code exchange / refresh ---

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(
  client: GoogleClient,
  code: string,
  redirectUri: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    const detail = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    return { ok: false, error: `Google rejected the authorization: ${detail}` };
  }
  const accessTokenEnc = json.access_token ? encryptSecret(json.access_token) : undefined;
  await prisma.apiCredential.upsert({
    where: { provider: "google_oauth_token" },
    update: {
      // The refresh token is the durable secret; keep the previous one if
      // Google doesn't reissue it (it does with prompt=consent).
      ...(json.refresh_token
        ? { encryptedKey: encryptSecret(json.refresh_token), keyHint: "google connection" }
        : {}),
      meta: JSON.stringify({
        mode: "oauth_token",
        accessTokenEnc,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      }),
    },
    create: {
      provider: "google_oauth_token",
      encryptedKey: encryptSecret(json.refresh_token ?? json.access_token ?? ""),
      keyHint: "google connection",
      meta: JSON.stringify({
        mode: "oauth_token",
        accessTokenEnc,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      }),
    },
  });
  return { ok: true };
}

/** Returns a live access token for the oauth_app connection, refreshing if needed. */
export async function getGoogleAccessToken(): Promise<string | null> {
  const cred = await prisma.apiCredential.findUnique({ where: { provider: "google_oauth_token" } });
  if (!cred) return null;
  try {
    const meta = cred.meta
      ? (JSON.parse(cred.meta) as { mode?: string; accessTokenEnc?: string; expiresAt?: number })
      : null;
    if (meta?.mode !== "oauth_token") return null;
    if (meta.accessTokenEnc && meta.expiresAt && meta.expiresAt - 60_000 > Date.now()) {
      return decryptSecret(meta.accessTokenEnc);
    }
    // expired (or missing) — refresh using the stored refresh token
    const refreshToken = decryptSecret(cred.encryptedKey);
    const client = await getGoogleClient();
    if (!client || !refreshToken) return null;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !json.access_token) return null;
    await prisma.apiCredential.update({
      where: { provider: "google_oauth_token" },
      data: {
        meta: JSON.stringify({
          mode: "oauth_token",
          accessTokenEnc: encryptSecret(json.access_token),
          expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        }),
      },
    });
    return json.access_token;
  } catch {
    return null;
  }
}

// --- Service account (JSON key) ---

// Scopes a service account needs for import; the "email" scope is only for
// the user-consent flow, so it's intentionally absent here.
const SERVICE_ACCOUNT_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

export interface ServiceAccountKey {
  clientEmail: string;
  tokenUri: string;
  privateKey: string;
}

/** Parses and sanity-checks a pasted service-account JSON key file. */
export function parseServiceAccountJson(text: string): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("That isn't valid JSON — paste the whole service-account key file.");
  }
  if (json.type !== "service_account") {
    throw new Error('That JSON is not a service-account key (expected "type": "service_account").');
  }
  const clientEmail = typeof json.client_email === "string" ? json.client_email : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key : "";
  const tokenUri = typeof json.token_uri === "string" ? json.token_uri : "https://oauth2.googleapis.com/token";
  if (!clientEmail.endsWith(".iam.gserviceaccount.com") || !privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("The key file is missing client_email / private_key — download it again from Google Cloud Console.");
  }
  return { clientEmail, tokenUri, privateKey };
}

export async function saveGoogleServiceAccount(text: string): Promise<ServiceAccountKey> {
  const parsed = parseServiceAccountJson(text);
  const encrypted = encryptSecret(text);
  await prisma.apiCredential.upsert({
    where: { provider: "google_service_account" },
    update: { encryptedKey: encrypted, keyHint: parsed.clientEmail, meta: JSON.stringify({ mode: "service_account", clientEmail: parsed.clientEmail }) },
    create: {
      provider: "google_service_account",
      encryptedKey: encrypted,
      keyHint: parsed.clientEmail,
      meta: JSON.stringify({ mode: "service_account", clientEmail: parsed.clientEmail }),
    },
  });
  return parsed;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Minted access tokens live 1h; keep one in memory so each import doesn't
// re-sign a JWT. Process restart just mints a fresh one.
let saTokenCache: { token: string; expiresAt: number } | null = null;

/** Mints an access token for the stored service account via the JWT bearer grant. */
export async function getServiceAccountAccessToken(): Promise<string | null> {
  if (saTokenCache && saTokenCache.expiresAt - 60_000 > Date.now()) return saTokenCache.token;
  const cred = await prisma.apiCredential.findUnique({ where: { provider: "google_service_account" } });
  if (!cred) return null;
  let key: ServiceAccountKey;
  try {
    key = parseServiceAccountJson(decryptSecret(cred.encryptedKey));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(
      JSON.stringify({
        iss: key.clientEmail,
        scope: SERVICE_ACCOUNT_SCOPES.join(" "),
        aud: key.tokenUri,
        exp: now + 3600,
        iat: now,
      })
    ),
  ].join(".");
  const signature = base64url(crypto.createSign("RSA-SHA256").update(assertion).sign(key.privateKey));
  const res = await fetch(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${assertion}.${signature}`,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) return null;
  saTokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

export interface GoogleCredential {
  token: string;
  mode: "api_key" | "oauth";
}

/**
 * Resolves the Google credential for import calls, in priority order:
 * 1. legacy "google" provider (api_key or raw oauth token),
 * 2. the oauth_app connection (auto-refreshed access token),
 * 3. the service account key (JWT-minted access token).
 */
export async function getGoogleCredential(): Promise<GoogleCredential | null> {
  const legacy = await prisma.apiCredential.findUnique({ where: { provider: "google" } });
  if (legacy) {
    const meta = legacy.meta ? (JSON.parse(legacy.meta) as { mode?: string }) : null;
    try {
      return {
        token: decryptSecret(legacy.encryptedKey),
        mode: meta?.mode === "oauth" ? "oauth" : "api_key",
      };
    } catch {
      /* fall through to oauth_app */
    }
  }
  const token = await getGoogleAccessToken();
  if (token) return { token, mode: "oauth" };
  const saToken = await getServiceAccountAccessToken();
  return saToken ? { token: saToken, mode: "oauth" } : null;
}
