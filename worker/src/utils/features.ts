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
// fronted by an in-isolate WeakMap memory cache (60s TTL).
// See docs/DESIGN.md §3.3.
//
// Architecture: memory miss → D1 SELECT (one query loads ALL flags at once).
// Staleness after an admin flip is bounded by MEM_TTL_MS (60s).

const MEM_TTL_MS = 60 * 1000;         // 60s — in-isolate freshness

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

  // Memory miss → query D1 directly (one SELECT loads all flags at once).
  const rows = await env.DB.prepare("SELECT key, value FROM features").all<{ key: string; value: number }>();
  const data: Record<string, boolean> = {};
  for (const r of rows.results ?? []) data[r.key] = r.value !== 0;
  c.bool = { data, exp: Date.now() + MEM_TTL_MS };
  return data;
}

async function loadStrMap(env: Env): Promise<Record<string, string>> {
  const c = envCache(env);
  if (c.str && c.str.exp > Date.now()) return c.str.data;

  // Memory miss → query D1 directly (one SELECT loads all flags at once).
  const rows = await env.DB.prepare("SELECT key, value FROM feature_strings").all<{ key: string; value: string }>();
  const data: Record<string, string> = {};
  for (const r of rows.results ?? []) data[r.key] = r.value;
  c.str = { data, exp: Date.now() + MEM_TTL_MS };
  return data;
}

export async function getFeature(env: Env, key: string): Promise<boolean> {
  const map = await loadBoolMap(env);
  return map[key] ?? false;
}

// key is accepted for call-site clarity but invalidation drops the whole merged
// map (cheap to rebuild — one SELECT). Keeps existing callers unchanged.
export function invalidateFeature(env: Env, _key?: string): void {
  envCache(env).bool = undefined;
}

export async function getFeatureString(env: Env, key: string, fallback = ""): Promise<string> {
  const map = await loadStrMap(env);
  return map[key] ?? fallback;
}

export function invalidateFeatureString(env: Env, _key?: string): void {
  envCache(env).str = undefined;
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
