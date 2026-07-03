// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Feature flags: D1 `features` table with KV read-through cache (TTL 60s),
// fronted by an in-isolate memory cache to collapse KV reads. See docs/DESIGN.md §3.3.

const CACHE_TTL = 60; // seconds — KV entry TTL
const MEM_TTL_MS = CACHE_TTL * 1000;

// In-isolate memoization. Cloudflare Workers isolates persist across many
// requests, so caching resolved values in module memory turns the previous
// "1 KV.get per feature check per request" cost into ~1 KV.get per key per TTL
// per warm isolate. Bounds staleness to CACHE_TTL, identical to the KV layer.
// Trade-off: after an admin flips a flag, a warm isolate that didn't service
// the write may serve the old value for up to CACHE_TTL (same window the KV
// TTL already allowed). invalidate* clears this isolate's entry immediately.
const memCache = new Map<string, { value: string; exp: number }>();

function memGet(key: string): string | null {
  const hit = memCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (hit) memCache.delete(key);
  return null;
}

function memSet(key: string, value: string): void {
  memCache.set(key, { value, exp: Date.now() + MEM_TTL_MS });
}

export async function getFeature(env: Env, key: string): Promise<boolean> {
  const cacheKey = `feature:${key}`;

  const mem = memGet(cacheKey);
  if (mem !== null) return mem === "1";

  const cached = await env.KV.get(cacheKey);
  if (cached !== null) {
    memSet(cacheKey, cached);
    return cached === "1";
  }

  const row = await env.DB.prepare("SELECT value FROM features WHERE key = ?")
    .bind(key)
    .first<{ value: number }>();
  const value = row ? row.value !== 0 : false;
  const encoded = value ? "1" : "0";
  await env.KV.put(cacheKey, encoded, { expirationTtl: CACHE_TTL });
  memSet(cacheKey, encoded);
  return value;
}

export async function invalidateFeature(env: Env, key: string): Promise<void> {
  memCache.delete(`feature:${key}`);
  await env.KV.delete(`feature:${key}`);
}

// 049 — string-valued feature flag accessor.
//
// `feature_strings` holds values that don't fit a 0/1 toggle: engine names,
// JSON-encoded profile lists, external URLs, etc. Same KV-fronted + in-isolate
// memoized cache shape as boolean features, stored under a different namespace.
export async function getFeatureString(env: Env, key: string, fallback = ""): Promise<string> {
  const cacheKey = `feature_str:${key}`;

  const mem = memGet(cacheKey);
  if (mem !== null) return mem;

  const cached = await env.KV.get(cacheKey);
  if (cached !== null) {
    memSet(cacheKey, cached);
    return cached;
  }

  const row = await env.DB.prepare("SELECT value FROM feature_strings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  const value = row?.value ?? fallback;
  await env.KV.put(cacheKey, value, { expirationTtl: CACHE_TTL });
  memSet(cacheKey, value);
  return value;
}

export async function invalidateFeatureString(env: Env, key: string): Promise<void> {
  memCache.delete(`feature_str:${key}`);
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
