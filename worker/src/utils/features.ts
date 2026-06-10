// Feature flags: D1 `features` table with KV read-through cache (TTL 60s).
// See docs/DESIGN.md §3.3.

const CACHE_TTL = 60;

export async function getFeature(env: Env, key: string): Promise<boolean> {
  const cacheKey = `feature:${key}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return cached === "1";

  const row = await env.DB.prepare("SELECT value FROM features WHERE key = ?")
    .bind(key)
    .first<{ value: number }>();
  const value = row ? row.value !== 0 : false;
  await env.KV.put(cacheKey, value ? "1" : "0", { expirationTtl: CACHE_TTL });
  return value;
}

export async function invalidateFeature(env: Env, key: string): Promise<void> {
  await env.KV.delete(`feature:${key}`);
}

// Proxy chain helpers (anti-loop). Chain is a comma-separated list of
// EdgeSonic INSTANCE_IDs accumulated across proxy hops.
export function parseChain(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
