import sharp from "sharp";
import { prisma } from "./db";
import { decryptSecret } from "./crypto";

// Vision-LLM adapter layer. The user's key (encrypted at rest) powers the
// secondary "describe and re-rank" pass. Provider is pluggable; adding one
// means adding a branch to `callVisionLLM` (see README "new source type").

export interface ReRankCandidate {
  itemId: string;
  sku?: string | null;
  name?: string | null;
  score: number;
  imageDataUrl: string; // small data-URL thumb for the model
}

export interface ReRankResult {
  bestItemId: string | null;
  reason: string;
  raw: string;
}

export async function getProviderKey(provider: string): Promise<string | null> {
  const cred = await prisma.apiCredential.findUnique({ where: { provider } });
  if (!cred) return null;
  try {
    return decryptSecret(cred.encryptedKey);
  } catch {
    return null; // never surface decrypt failures as key material
  }
}

async function toDataUrl(buf: Buffer, mime = "image/jpeg"): Promise<string> {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function callOpenAI(key: string, queryB64: string, cands: ReRankCandidate[]): Promise<string> {
  const content: unknown[] = [
    { type: "text", text: promptText(cands) },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${queryB64}` } },
    ...cands.map((c) => ({ type: "image_url" as const, image_url: { url: c.imageDataUrl } })),
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

async function callGoogle(key: string, queryB64: string, cands: ReRankCandidate[]): Promise<string> {
  const parts: unknown[] = [{ text: promptText(cands) }, { inline_data: { mime_type: "image/jpeg", data: queryB64 } }];
  for (const c of cands) {
    const m = c.imageDataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );
  if (!res.ok) throw new Error(`Google error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

async function callAnthropic(key: string, queryB64: string, cands: ReRankCandidate[]): Promise<string> {
  const content: unknown[] = [
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: queryB64 },
    },
    ...cands.map((c) => {
      const m = c.imageDataUrl.match(/^data:(.+?);base64,(.+)$/);
      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: m?.[1] ?? "image/jpeg", data: m?.[2] ?? "" },
      };
    }),
    { type: "text", text: promptText(cands) },
  ];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 300, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content?: { text?: string }[] };
  return json.content?.map((c) => c.text ?? "").join("") ?? "";
}

function promptText(cands: ReRankCandidate[]): string {
  const lines = cands
    .map((c, i) => `Candidate ${String.fromCharCode(65 + i)}: id=${c.itemId} SKU=${c.sku ?? "?"} name=${c.name ?? "?"} (vector score ${c.score.toFixed(3)})`)
    .join("\n");
  return [
    "The FIRST image is a query photo of a physical item.",
    "The following images are candidate catalog photos, in order:",
    lines,
    "",
    "Decide which candidate shows the same item as the query photo.",
    'Respond with ONLY strict JSON: {"best": "A"|"B"|"C"|..., "reason": "<one sentence>"}.',
    "If none plausibly match, respond {\"best\": null, \"reason\": \"...\"}.",
  ].join("\n");
}

export async function reRankWithVision(
  queryBuf: Buffer,
  candidates: ReRankCandidate[]
): Promise<ReRankResult> {
  // Preferred provider comes from the env var, but never hard-fail because of
  // it: fall back to whichever vision-capable credential is actually saved.
  const preferred = process.env.VISION_RERANK_PROVIDER ?? "openai";
  const providerOrder = [
    preferred,
    ...["openai", "gemini", "anthropic"].filter((p) => p !== preferred),
  ];
  let provider: string | null = null;
  let key: string | null = null;
  for (const p of providerOrder) {
    const k =
      p === "google" || p === "gemini"
        ? (await getProviderKey("gemini")) ?? (await getProviderKey("google"))
        : await getProviderKey(p);
    if (k) {
      provider = p;
      key = k;
      break;
    }
  }
  if (!provider || !key) {
    throw new Error(
      `No vision API key configured (looked for: ${providerOrder.join(", ")}). Add one on the Settings page.`
    );
  }

  const queryB64 = await sharpToJpegB64(queryBuf);
  let raw = "";
  if (provider === "openai") raw = await callOpenAI(key, queryB64, candidates);
  else if (provider === "google" || provider === "gemini") raw = await callGoogle(key, queryB64, candidates);
  else if (provider === "anthropic") raw = await callAnthropic(key, queryB64, candidates);
  else throw new Error(`Unknown provider ${provider}`);

  const parsed = parseBest(raw, candidates.length);
  if (parsed.bestIndex === null) return { bestItemId: null, reason: parsed.reason, raw };
  return { bestItemId: candidates[parsed.bestIndex].itemId, reason: parsed.reason, raw };
}

function parseBest(raw: string, n: number): { bestIndex: number | null; reason: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { best?: string | null; reason?: string };
      if (typeof obj.best === "string" && obj.best.length === 1) {
        const idx = obj.best.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < n) return { bestIndex: idx, reason: obj.reason ?? "" };
      }
      return { bestIndex: null, reason: obj.reason ?? "no match" };
    } catch {
      /* fall through to letter scan */
    }
  }
  const letter = raw.match(/\b([A-C])\b/);
  if (letter) return { bestIndex: letter[1].charCodeAt(0) - 65, reason: raw.slice(0, 200) };
  return { bestIndex: null, reason: raw.slice(0, 200) || "unparsable response" };
}

async function sharpToJpegB64(buf: Buffer): Promise<string> {
  const jpeg = await sharp(buf, { failOn: "none" }).rotate().resize(768, 768, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return jpeg.toString("base64");
}

export async function makeThumbDataUrl(buf: Buffer): Promise<string> {
  const jpeg = await sharp(buf, { failOn: "none" }).rotate().resize(320, 320, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

export { toDataUrl };
