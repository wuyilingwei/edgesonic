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

//
// Browser sessions can never use the WebDAV presign 302 (UserInfo URLs are
// blocked on cross-origin redirects), so their WebDAV playback is stuck on
// the proxied in-Worker stream, which shares the sub-request outbound
// bandwidth pool (~1.2 MB/s observed, less under concurrency / slow origins).
// The only code-level escape hatch is to stop re-fetching from WebDAV at all:
// on first play we copy the whole file into R2 in the background and register
// a source_type='cached' song_instances row. The stream selector already
// prefers r2:// instances (093), so the next play automatically rides the R2
// fast path (Worker binding, or a presigned 302 when enable_r2_presign is on).
//
// caching itself is now gated per-source (storage_sources.cache_tier)
// instead of the old single global enable_webdav_hotcache boolean, and the
// per-file cap / total budget / TTL come from that source's tier config.
// Callers no longer need to check the flag before calling hotCacheWebdav —
// it's a no-op (after one D1 lookup) for sources on cache_tier='off'.

import { createWebDAVAdapter } from "../adapters/webdav";
import type { SongInstance } from "../types/entities";
import { getSourceCacheTier, resolveTierConfig, evictExpired, evictForRoom } from "./cacheTiers";

export function hotCacheWebdav(
  env: Env,
  source: SongInstance,
  executionCtx: ExecutionContext<unknown>,
): void {
  executionCtx.waitUntil(doHotCache(env, source).catch(() => {}));
}

async function doHotCache(env: Env, source: SongInstance): Promise<void> {
  const tier = await getSourceCacheTier(env, source.source_id);
  if (tier === "off") return;
  const tierConfig = await resolveTierConfig(env, tier);
  if (!tierConfig) return;

  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `cache/webdav/${source.master_id}.${source.suffix}`;
  const instanceId = `si-whc-${source.master_id}`;

  // Atomic claim: the deterministic id makes INSERT OR IGNORE a mutex — a
  // concurrent request (or a Range follow-up from the same <audio> element)
  // sees changes=0 and bails. missing=1 hides the row from playback until the
  // copy lands, and (being missing=1) it's excluded from evictForRoom's usage
  // total and eviction candidates below, so it can never evict itself.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO song_instances
       (id, master_id, source_id, source_type, parent_instance_id, storage_uri,
        suffix, content_type, bit_rate, sample_rate, bit_depth, channels,
        duration, size, missing, tag_scanned, created_at, updated_at)
     VALUES (?, ?, 'r2-local', 'cached', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  ).bind(
    instanceId,
    source.master_id,
    source.id,
    `r2://${cacheKey}`,
    source.suffix,
    source.content_type,
    source.bit_rate,
    source.sample_rate,
    source.bit_depth,
    source.channels,
    source.duration,
    source.size,
    now,
    now,
  ).run();
  if (claim.meta.changes === 0) return; // already cached or in flight

  try {
    // Hard-TTL sweep first so already-dead rows free their bytes before we
    // count live usage, then evict LRU-oldest until this file will fit.
    await evictExpired(env, source.source_id, now);
    await evictForRoom(env, source.source_id, source.size ?? 0, tierConfig);

    const resp = await createWebDAVAdapter(env.DB, env).stream(source.storage_uri);
    const len = resp.contentLength;
    // R2 put needs a known stream length; unknown / oversized → abandon claim.
    if (!resp.body || resp.statusCode >= 400 || !len || len > tierConfig.maxFileBytes) {
      if (resp.body) await resp.body.cancel().catch(() => {});
      await env.DB.prepare("DELETE FROM song_instances WHERE id = ? AND missing = 1").bind(instanceId).run();
      return;
    }

    await env.MUSIC_BUCKET.put(cacheKey, resp.body, {
      httpMetadata: { contentType: resp.contentType || "application/octet-stream" },
    });

    const wroteAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE song_instances SET missing = 0, size = ?, expires_at = ?, last_accessed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(len, wroteAt + tierConfig.ttlSeconds, wroteAt, wroteAt, instanceId).run();
  } catch {
    await env.MUSIC_BUCKET.delete(cacheKey).catch(() => {});
    await env.DB.prepare("DELETE FROM song_instances WHERE id = ? AND missing = 1").bind(instanceId).run();
  }
}
