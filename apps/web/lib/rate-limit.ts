import Redis from "ioredis";

/**
 * Fixed-window rate limiter. Uses Redis when REDIS_URL is reachable so limits hold across pods;
 * falls back to per-process memory (dev / Redis outage) instead of failing open without any limit.
 */
const g = globalThis as unknown as { __rlRedis?: Redis | null; __rlMem?: Map<string, { n: number; exp: number }> };

function redis(): Redis | null {
  if (g.__rlRedis !== undefined) return g.__rlRedis;
  const url = process.env.REDIS_URL;
  if (!url || process.env.NODE_ENV === "test") return (g.__rlRedis = null);
  const r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  r.on("error", () => {});
  r.connect().catch(() => {});
  return (g.__rlRedis = r);
}

export interface RateResult { allowed: boolean; remaining: number; retryAfterSec: number }

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateResult> {
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const r = redis();
  if (r && r.status === "ready") {
    try {
      const n = await r.incr(bucket);
      if (n === 1) await r.expire(bucket, windowSec + 1);
      return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterSec: windowSec };
    } catch {
      /* fall through to memory */
    }
  }
  const mem = (g.__rlMem ??= new Map());
  const now = Date.now();
  for (const [k, v] of mem) if (v.exp < now) mem.delete(k);
  const cur = mem.get(bucket) ?? { n: 0, exp: now + windowSec * 1000 };
  cur.n += 1;
  mem.set(bucket, cur);
  return { allowed: cur.n <= limit, remaining: Math.max(0, limit - cur.n), retryAfterSec: windowSec };
}
