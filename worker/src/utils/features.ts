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

// Feature flags: D1 (`features` / `feature_strings`) is the source of truth,
// fronted by a single merged KV blob per namespace + an in-isolate memory cache.
// See docs/DESIGN.md §3.3.
//
// Why one merged blob instead of one KV key per flag:
//   - Storage: KV bills per key + per-key metadata overhead; a dozen tiny
//     `feature:*` keys cost more (and more list churn) than one small JSON blob.
//   - Reads: a single KV.get loads EVERY flag into the isolate at once, so the
//     first feature check per warm isolate per TTL does one KV read and every
//     subsequent check (any key) is served from memory.
// The COI middleware runs getFeatureString on every request, so collapsing that
// to ~1 KV read per isolate per TTL is the main KV-cost reduction.

// Two independent TTLs. Memory TTL is short (freshness) — an admin toggle
// propagates to a warm isolate within this window. KV TTL is long, because KV
// is only a shared cache in front of D1: writes to KV are the scarce quota
// (free tier ~1k/day), so we want them RARE. With a short KV TTL the blob was
// rewritten on every ~60s expiry per active isolate → thousands of KV.put/day.
// A long KV TTL means the blob is (re)written ~once/hour/isolate + on explicit
// invalidate (admin flips a flag → invalidate* deletes it → next read rebuilds).
// Memory-miss but KV-hit costs only a KV.get, never a put.
const MEM_TTL_MS = 60 * 1000;         // 60s — in-isolate freshness
const KV_TTL_SECONDS = 60 * 60;       // 1h  — KV cache lifetime (write-rare)

const BOOL_KV_KEY = "features:all";
const STR_KV_KEY = "feature_strings:all";

// In-isolate memoization of the whole map, keyed by the `env` object. A Worker
// isolate reuses the same env across requests, so the cache persists and bounds
// KV reads to ~1 per namespace per TTL per warm isolate. Keying by env (rather
// than a module-global) means unit tests that spin up multiple (D1, KV) envs in
// one process each get an isolated cache — no cross-scenario leak — and if the
// runtime ever handed us a fresh env per request we'd simply degrade to one
// blob read per request (still far cheaper than one read per flag), never wrong.
//
// Trade-off: invalidate* deletes the KV blob + this env's copy immediately, so
// other warm isolates serve the old map only until their MEM_TTL_MS (60s)
// lapses — their next memory-miss hits the now-absent KV blob and rebuilds from
// D1. Staleness after an admin flip is therefore bounded by MEM_TTL_MS.
type EnvCache = {
  bool?: { data: Record<string, boolean>; exp: number };
  str?: { data: Record<string, string>; exp: number };
};
const cacheByEnv = new WeakMap<object, EnvCache>();

function envCache(env: Env): EnvCache {
  let c = cacheByEnv.get(env as unknown as object);
  if (!c) { c = {}; cacheByEnv.set(env as unknown as object, c); }
  return c;
}

async function loadBoolMap(env: Env): Promise<Record<string, boolean>> {
  const c = envCache(env);
  if (c.bool && c.bool.exp > Date.now()) return c.bool.data;

  const cached = await env.KV.get(BOOL_KV_KEY);
  if (cached !== null) {
    try {
      const data = JSON.parse(cached) as Record<string, boolean>;
      c.bool = { data, exp: Date.now() + MEM_TTL_MS };
      return data;
    } catch { /* corrupt blob → rebuild from D1 below */ }
  }

  const rows = await env.DB.prepare("SELECT key, value FROM features").all<{ key: string; value: number }>();
  const data: Record<string, boolean> = {};
  for (const r of rows.results ?? []) data[r.key] = r.value !== 0;
  await env.KV.put(BOOL_KV_KEY, JSON.stringify(data), { expirationTtl: KV_TTL_SECONDS });
  c.bool = { data, exp: Date.now() + MEM_TTL_MS };
  return data;
}

async function loadStrMap(env: Env): Promise<Record<string, string>> {
  const c = envCache(env);
  if (c.str && c.str.exp > Date.now()) return c.str.data;

  const cached = await env.KV.get(STR_KV_KEY);
  if (cached !== null) {
    try {
      const data = JSON.parse(cached) as Record<string, string>;
      c.str = { data, exp: Date.now() + MEM_TTL_MS };
      return data;
    } catch { /* corrupt blob → rebuild from D1 below */ }
  }

  const rows = await env.DB.prepare("SELECT key, value FROM feature_strings").all<{ key: string; value: string }>();
  const data: Record<string, string> = {};
  for (const r of rows.results ?? []) data[r.key] = r.value;
  await env.KV.put(STR_KV_KEY, JSON.stringify(data), { expirationTtl: KV_TTL_SECONDS });
  c.str = { data, exp: Date.now() + MEM_TTL_MS };
  return data;
}

export async function getFeature(env: Env, key: string): Promise<boolean> {
  const map = await loadBoolMap(env);
  return map[key] ?? false;
}

// key is accepted for call-site clarity but invalidation drops the whole merged
// blob (cheap to rebuild — one SELECT). Keeps existing callers unchanged.
export async function invalidateFeature(env: Env, _key?: string): Promise<void> {
  envCache(env).bool = undefined;
  await env.KV.delete(BOOL_KV_KEY);
}

export async function getFeatureString(env: Env, key: string, fallback = ""): Promise<string> {
  const map = await loadStrMap(env);
  return map[key] ?? fallback;
}

export async function invalidateFeatureString(env: Env, _key?: string): Promise<void> {
  envCache(env).str = undefined;
  await env.KV.delete(STR_KV_KEY);
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
