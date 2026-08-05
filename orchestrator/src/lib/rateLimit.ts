/**
 * Simple sliding-window rate limit (per process). Enough for lab/staging;
 * put a reverse proxy limit in front for multi-instance prod.
 */
type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): { ok: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = opts.windowMs;
  let b = buckets.get(opts.key);
  if (!b) {
    b = { timestamps: [] };
    buckets.set(opts.key, b);
  }
  b.timestamps = b.timestamps.filter((t) => now - t < windowMs);
  if (b.timestamps.length >= opts.limit) {
    const oldest = b.timestamps[0]!;
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return { ok: false, remaining: 0, retryAfterSec };
  }
  b.timestamps.push(now);
  return { ok: true, remaining: opts.limit - b.timestamps.length, retryAfterSec: 0 };
}

/** Message / webhook ingress defaults. */
export function ingressRateLimit(account: string): ReturnType<typeof rateLimit> {
  const limit = Number(process.env.RATE_LIMIT_PER_MIN ?? 30);
  return rateLimit({ key: `ingress:${account}`, limit, windowMs: 60_000 });
}

/** Clear buckets (tests). */
export function resetRateLimits(): void {
  buckets.clear();
}
