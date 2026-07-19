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

// per-source R2 hot-cache tiers, replacing the old single global
// enable_webdav_hotcache boolean + hardcoded 300MB/file cap + zero eviction.
//
// Each non-R2 storage source picks a cache_tier ('off' | 'standard' |
// 'extended'). 'standard' and 'extended' each carry a total-byte budget, a
// per-file cap, and a TTL, tunable via the cache_tier_standard /
// cache_tier_extended feature_strings (JSON). Cached rows always physically
// live in R2 (song_instances.source_id='r2-local', source_type='cached'), but
// which remote storage_sources row they were cached FROM — and therefore
// which tier's budget they count against — is only recoverable by following
// parent_instance_id back to the original instance's source_id. All queries
// below join through that.
//
// Two independent safety nets, not one feeding the other:
//  - TTL is a hard ceiling set once at cache-write time and never extended by
//    replays — guarantees eventual cleanup even for a source that's under
//    budget forever.
//  - LRU (last_accessed_at) only decides eviction ORDER when a source is over
//    its budget — it never extends or shortens the TTL.

import { getFeatureString } from "./features";
import { ensureCacheTierColumns } from "./schema_patch";

export type CacheTierName = "off" | "standard" | "extended";

export interface TierConfig {
  budgetBytes: number;
  maxFileBytes: number;
  ttlSeconds: number;
}

const MB = 1024 * 1024;
const DAY_SEC = 24 * 60 * 60;

// Fallback if the feature_strings row is missing or fails to parse — mirrors
// the Schema.sql seed values so a fresh/corrupt row still behaves sanely.
const TIER_DEFAULTS: Record<Exclude<CacheTierName, "off">, TierConfig> = {
  standard: { budgetBytes: 2048 * MB, maxFileBytes: 300 * MB, ttlSeconds: 30 * DAY_SEC },
  extended: { budgetBytes: 10240 * MB, maxFileBytes: 1024 * MB, ttlSeconds: 5 * DAY_SEC },
};

function parseTierJson(raw: string): { budgetMb: number; maxFileMb: number; ttlDays: number } | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null ||
      !Number.isFinite(parsed.budgetMb) || !Number.isFinite(parsed.maxFileMb) || !Number.isFinite(parsed.ttlDays)
    ) return null;
    return { budgetMb: parsed.budgetMb, maxFileMb: parsed.maxFileMb, ttlDays: parsed.ttlDays };
  } catch {
    return null;
  }
}

export async function resolveTierConfig(env: Env, tier: CacheTierName): Promise<TierConfig | null> {
  if (tier === "off") return null;
  const key = tier === "standard" ? "cache_tier_standard" : "cache_tier_extended";
  const raw = await getFeatureString(env, key, "");
  const parsed = raw ? parseTierJson(raw) : null;
  if (!parsed) return TIER_DEFAULTS[tier];
  return {
    budgetBytes: Math.max(0, parsed.budgetMb) * MB,
    maxFileBytes: Math.max(0, parsed.maxFileMb) * MB,
    ttlSeconds: Math.max(0, parsed.ttlDays) * DAY_SEC,
  };
}

// No row → source was never configured for caching → 'off' (never silently
// starts consuming R2 storage for a source nobody opted in).
export async function getSourceCacheTier(env: Env, sourceId: string): Promise<CacheTierName> {
  await ensureCacheTierColumns(env);
  const row = await env.DB.prepare("SELECT cache_tier FROM storage_sources WHERE id = ?")
    .bind(sourceId).first<{ cache_tier: string }>();
  const tier = row?.cache_tier;
  return tier === "standard" || tier === "extended" ? tier : "off";
}

interface CachedRow {
  id: string;
  storage_uri: string;
  size: number | null;
}

async function deleteCachedRow(env: Env, row: CachedRow): Promise<void> {
  const key = row.storage_uri.startsWith("r2://") ? row.storage_uri.slice("r2://".length) : null;
  if (key) await env.MUSIC_BUCKET.delete(key).catch(() => {});
  await env.DB.prepare("DELETE FROM song_instances WHERE id = ?").bind(row.id).run();
}

// Deletes cached rows whose hard TTL has already elapsed for the given
// origin source, regardless of current budget usage. Safe to call on every
// cache write and from the cron sweep — idempotent, no-op when nothing is
// expired.
export async function evictExpired(env: Env, originSourceId: string, now: number): Promise<number> {
  const expired = await env.DB.prepare(
    `SELECT c.id, c.storage_uri, c.size
     FROM song_instances c
     JOIN song_instances parent ON parent.id = c.parent_instance_id
     WHERE c.source_type = 'cached' AND c.missing = 0
       AND parent.source_id = ?
       AND c.expires_at IS NOT NULL AND c.expires_at < ?`,
  ).bind(originSourceId, now).all<CachedRow>();
  for (const row of expired.results ?? []) await deleteCachedRow(env, row);
  return expired.results?.length ?? 0;
}

// Evicts least-recently-used cached rows for `originSourceId` until adding
// `incomingBytes` more would fit under `tierConfig.budgetBytes`. Call
// evictExpired first so already-dead rows are freed before this counts
// live usage. Returns the number of rows evicted.
export async function evictForRoom(
  env: Env,
  originSourceId: string,
  incomingBytes: number,
  tierConfig: TierConfig,
): Promise<number> {
  const totalRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(c.size), 0) AS bytes
     FROM song_instances c
     JOIN song_instances parent ON parent.id = c.parent_instance_id
     WHERE c.source_type = 'cached' AND c.missing = 0 AND parent.source_id = ?`,
  ).bind(originSourceId).first<{ bytes: number }>();
  let current = totalRow?.bytes ?? 0;
  if (current + incomingBytes <= tierConfig.budgetBytes) return 0;

  // NULL last_accessed_at sorts first in ASC — a cached row that was never
  // replayed since it was written is evicted before any row with a real hit.
  const candidates = await env.DB.prepare(
    `SELECT c.id, c.storage_uri, c.size
     FROM song_instances c
     JOIN song_instances parent ON parent.id = c.parent_instance_id
     WHERE c.source_type = 'cached' AND c.missing = 0 AND parent.source_id = ?
     ORDER BY c.last_accessed_at ASC, c.created_at ASC`,
  ).bind(originSourceId).all<CachedRow>();

  let evicted = 0;
  for (const row of candidates.results ?? []) {
    if (current + incomingBytes <= tierConfig.budgetBytes) break;
    await deleteCachedRow(env, row);
    current -= row.size ?? 0;
    evicted++;
  }
  return evicted;
}
