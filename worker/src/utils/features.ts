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

// 049 — string-valued feature flag accessor.
//
// `feature_strings` holds values that don't fit a 0/1 toggle: engine names,
// JSON-encoded profile lists, external URLs, etc. Same KV-fronted cache
// shape as boolean features, but stored under a different namespace.
export async function getFeatureString(env: Env, key: string, fallback = ""): Promise<string> {
  const cacheKey = `feature_str:${key}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return cached;

  const row = await env.DB.prepare("SELECT value FROM feature_strings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  const value = row?.value ?? fallback;
  await env.KV.put(cacheKey, value, { expirationTtl: CACHE_TTL });
  return value;
}

export async function invalidateFeatureString(env: Env, key: string): Promise<void> {
  await env.KV.delete(`feature_str:${key}`);
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
