import sharp, { type Sharp } from "sharp";
import crypto from "crypto";

// Zero-key local embedding engine: a 4-crop 64-bit pHash ensemble (256-dim),
// L2-normalized. Runs entirely offline — no API key needed for the primary
// match. An adapter layer (vision.ts) lets a user-keyed vision LLM re-rank.
//
// "Same model" is guaranteed structurally: the same code path embeds both
// catalog images and identify queries, and every stored row records modelUsed.

export const EMBEDDING_MODEL_ID = "phash4crop+ring-v3";
export const EMBEDDING_DIM = 288; // 256 pHash block (4×64, each L2-normalized) + 32 ring block

// Ring block weight in the normalized concat: rotation-invariant signal is
// weighted so a rotated query of the right item clears the match threshold,
// while wrong items (ring cosine ~0.3) stay well below it.
const RING_WEIGHT = 5;

function hashToVec(bits: bigint, dim = 64): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) vec.push((bits >> BigInt(i)) & 1n ? 1 : -1);
  return vec;
}

function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// 64-bit dHash (difference hash) — more stable than aHash under exposure shifts.
async function dhash64(img: Sharp): Promise<bigint> {
  const { data, info } = await img
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = y * info.channels! * 9 + x * info.channels!;
      if (data[idx] > data[idx + info.channels!]) bits |= 1n << BigInt(y * 8 + x);
    }
  }
  return bits;
}

// 8 concentric-ring color/texture descriptor over a 64×64 normalized image.
// Rotation-invariant by construction (rings don't depend on orientation), and
// brightness-robust (each channel is normalized by the image-wide mean).
// This rescues rotated/cropped queries where pHash block-matching alone flips.
async function ringDescriptor(buf: Buffer): Promise<number[]> {
  const { data, info } = await sharp(buf, { failOn: "none" })
    .rotate()
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const N = 64;
  const RINGS = 8;
  const rMax = 45.25; // half-diagonal, so rings tile the full frame
  const acc = Array.from({ length: RINGS }, () => ({ r: 0, g: 0, b: 0, grad: 0, n: 0 }));
  const grey = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    grey[i] = 0.299 * data[i * ch] + 0.587 * data[i * ch + 1] + 0.114 * data[i * ch + 2];
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - (N - 1) / 2;
      const dy = y - (N - 1) / 2;
      const ring = Math.min(RINGS - 1, Math.floor(Math.sqrt(dx * dx + dy * dy) / (rMax / RINGS)));
      const i4 = (y * N + x) * ch;
      const a = acc[ring];
      a.r += data[i4];
      a.g += data[i4 + 1];
      a.b += data[i4 + 2];
      const gx = grey[y * N + Math.min(N - 1, x + 1)] - grey[y * N + Math.max(0, x - 1)];
      const gy = grey[Math.min(N - 1, y + 1) * N + x] - grey[Math.max(0, y - 1) * N + x];
      a.grad += Math.sqrt(gx * gx + gy * gy);
      a.n++;
    }
  }
  const mean = (f: (a: (typeof acc)[number]) => number) => acc.reduce((s, a) => s + f(a), 0) / RINGS || 1;
  const mR = mean((a) => a.r / a.n);
  const mG = mean((a) => a.g / a.n);
  const mB = mean((a) => a.b / a.n);
  const mGrad = mean((a) => a.grad / a.n);
  const out: number[] = [];
  for (const a of acc) {
    out.push(a.r / a.n / mR - 1, a.g / a.n / mG - 1, a.b / a.n / mB - 1, a.grad / a.n / mGrad - 1);
  }
  return l2normalize(out);
}

export async function embedImage(buf: Buffer): Promise<number[]> {
  const base = sharp(buf, { failOn: "none" }).rotate(); // respect EXIF orientation
  const meta = await base.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("unreadable image");

  const crops: Sharp[] = [base.clone()];
  // center 60% crop captures the object while downweighting background clutter
  crops.push(
    sharp(buf, { failOn: "none" })
      .rotate()
      .extract({ left: Math.floor(w * 0.2), top: Math.floor(h * 0.2), width: Math.floor(w * 0.6), height: Math.floor(h * 0.6) })
  );
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);
  for (const region of [
    { left: 0, top: 0, width: hw, height: hh },
    { left: w - hw, top: h - hh, width: hw, height: hh },
  ]) {
    crops.push(sharp(buf, { failOn: "none" }).rotate().extract(region));
  }

  // Per-block L2 normalization keeps the dot product interpretable as a
  // weighted mean of block cosines (raw ±1 hash vectors would otherwise
  // swamp the ring block by 256:4).
  const vec: number[] = [];
  for (const c of crops) vec.push(...l2normalize(hashToVec(await dhash64(c))));
  for (const v of await ringDescriptor(buf)) vec.push(v * RING_WEIGHT);
  return l2normalize(vec);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

export function stableEmbedding(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
