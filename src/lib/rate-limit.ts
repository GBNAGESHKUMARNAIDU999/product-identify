// In-memory sliding-window rate limiter (per-IP). Protects the Identify
// endpoint against runaway vision-API spend. For multi-instance deployments
// swap the Map for Redis (see README).

const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    const retryAfterSec = Math.ceil((windowMs - (now - arr[0])) / 1000);
    hits.set(key, arr);
    return { ok: false, retryAfterSec };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true, retryAfterSec: 0 };
}
