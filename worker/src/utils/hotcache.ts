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

import { createWebDAVAdapter } from "../adapters/webdav";
import type { SongInstance } from "../types/entities";

// Above this we skip caching: R2 put still works, but a single 4h DSD rip
// would eat a third of the free tier. Flag owners can raise it in code later.
const MAX_CACHE_BYTES = 300 * 1024 * 1024;

export function hotCacheWebdav(
  env: Env,
  source: SongInstance,
  executionCtx: ExecutionContext<unknown>,
): void {
  executionCtx.waitUntil(doHotCache(env, source).catch(() => {}));
}

async function doHotCache(env: Env, source: SongInstance): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `cache/webdav/${source.master_id}.${source.suffix}`;
  const instanceId = `si-whc-${source.master_id}`;

  // Atomic claim: the deterministic id makes INSERT OR IGNORE a mutex — a
  // concurrent request (or a Range follow-up from the same <audio> element)
  // sees changes=0 and bails. missing=1 hides the row from playback until the
  // copy lands.
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
    const resp = await createWebDAVAdapter(env.DB, env).stream(source.storage_uri);
    const len = resp.contentLength;
    // R2 put needs a known stream length; unknown / oversized → abandon claim.
    if (!resp.body || resp.statusCode >= 400 || !len || len > MAX_CACHE_BYTES) {
      if (resp.body) await resp.body.cancel().catch(() => {});
      await env.DB.prepare("DELETE FROM song_instances WHERE id = ? AND missing = 1").bind(instanceId).run();
      return;
    }

    await env.MUSIC_BUCKET.put(cacheKey, resp.body, {
      httpMetadata: { contentType: resp.contentType || "application/octet-stream" },
    });

    await env.DB.prepare(
      "UPDATE song_instances SET missing = 0, size = ?, updated_at = ? WHERE id = ?",
    ).bind(len, Math.floor(Date.now() / 1000), instanceId).run();
  } catch {
    await env.MUSIC_BUCKET.delete(cacheKey).catch(() => {});
    await env.DB.prepare("DELETE FROM song_instances WHERE id = ? AND missing = 1").bind(instanceId).run();
  }
}
