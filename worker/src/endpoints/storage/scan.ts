import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { md5 } from "../../utils/md5";
import { createQueries } from "../../db/queries";
import { getFeatureString } from "../../utils/features";
import { dispatchWorkBatch } from "../edgesonic/work";

export const scanRoutes = new Hono();

const AUDIO_EXT = new Set(["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "ape", "wma", "aiff", "alac", "dsf"]);
// Workers cap subrequests per invocation; leave headroom for D1/KV traffic.
const MAX_DAV_REQUESTS = 40;
// Update scan_jobs.scanned_items every N inserts so getScanStatus stays fresh.
const SCAN_PROGRESS_CHUNK = 80;

export interface DavEntry {
  path: string;        // path relative to the source root, URL-decoded
  isDir: boolean;
  size: number;
  contentType: string | null;
  // 051 — Incremental scan signals. Both come from PROPFIND, both are nullable
  // because not every WebDAV server is honest about them (iCloud, Nextcloud,
  // generic Apache mod_dav all behave differently).
  etag: string | null;
  lastModified: number | null;     // unix seconds
}

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
  // 089 S2 — 'library' (default) | 'sync_only' (scan but skip DB inserts)
  mode?: string | null;
}

// 051 — Existing-instance snapshot used by asyncScanSource to decide skip/UPDATE/INSERT.
interface ExistingRow {
  id: string;
  etag: string | null;
  lastModified: number | null;
  size: number | null;
  tagScanned: number;
}

// Kick off a WebDAV scan. The actual work runs inside ctx.waitUntil so the
// HTTP response returns immediately; clients poll /rest/getScanStatus for
// progress / completion. Each invocation creates one scan_jobs row per source.
// GET /rest/startScan[?id=<sourceId>]
scanRoutes.get("/scan/start", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const onlyId = c.req.query("id");

  const sources = (await db.prepare(
    `SELECT id, base_url, username, password, root_path, mode FROM storage_sources
     WHERE type = 'webdav' AND enabled = 1 ${onlyId ? "AND id = ?" : ""}`
  ).bind(...(onlyId ? [onlyId] : [])).all<SourceRow>()).results;

  if (sources.length === 0) {
    return c.text(subsonicError(70, "No enabled WebDAV source to scan"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const queries = createQueries(db);
  const jobs: Array<{ id: string; source_id: string }> = [];

  // Insert scan_jobs rows synchronously so getScanStatus immediately sees them
  // as running; the actual scan runs in ctx.waitUntil.
  for (const src of sources) {
    const jobId = "sj-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    await queries.insertScanJob({ id: jobId, sourceId: src.id });
    jobs.push({ id: jobId, source_id: src.id });
  }

  // 051 — read scan_etag_check once so each background scan sees a coherent
  // snapshot; KV-fronted feature_strings makes this cheap.
  // 076 — `?force=1` query param overrides the feature flag and disables the
  // ETag short-circuit so every existing instance hits path 2 (UPDATE +
  // tag_scanned=0). UX: scan button Shift+click → user feels work happening
  // when an otherwise-identical second scan would have skipped every row.
  const forceQuery = (c.req.query("force") || "").toLowerCase();
  const force = forceQuery === "1" || forceQuery === "true";
  const etagCheck = force ? false : (await getFeatureString(env, "scan_etag_check", "1")) !== "0";
  // 052 — when the browser worker pool is enabled, every changed/new file
  // gets a `metadata` task pushed into work_queue so opted-in browsers will
  // parse the tags. The scan job itself is unchanged — the dispatch happens
  // after asyncScanSource finishes flushing its INSERT/UPDATE batch.
  const workerPoolEnabled = (await getFeatureString(env, "worker_pool_enabled", "1")) !== "0";

  // ctx.waitUntil keeps the Worker alive until the scan finishes (subject to
  // platform CPU/wall caps); the response below returns right away.
  const exec = c.executionCtx;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const src = sources[i];
    exec.waitUntil(asyncScanSource(db, src, job.id, { etagCheck, dispatchToWorkerPool: workerPoolEnabled }));
  }

  return c.text(
    subsonicOK({
      scanResult: {
        _attributes: { scanning: "true", count: 0 },
        source: jobs.map((j) => ({
          _attributes: { id: j.source_id, jobId: j.id, status: "running" },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

// Report aggregate scan status across the most recent job per source.
// GET /rest/getScanStatus -> <scanStatus scanning="true|false" count="N"/>
scanRoutes.get("/scan/status", async (c) => {
  const env = c.env as Env;
  const queries = createQueries(env.DB);
  const latest = await queries.getLatestScanJobs();
  const scanning = latest.some((j) => j.status === "running");
  const count = latest.reduce((acc, j) => acc + (j.scanned_items || 0), 0);

  return c.text(
    subsonicOK({
      scanStatus: {
        _attributes: { scanning: String(scanning), count },
        source: latest.map((j) => ({
          _attributes: {
            id: j.source_id,
            jobId: j.id,
            status: j.status,
            total: j.total_items,
            scanned: j.scanned_items,
            startedAt: j.started_at,
            endedAt: j.ended_at ?? undefined,
            error: j.error_message ?? undefined,
          },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

// 051 — pending list for the BROWSER READ queue. Files.vue polls this so it
// knows how many tag re-reads remain after an incremental scan flips
// tag_scanned back to 0. JSON response (the whole /storage/* bucket is JSON-
// shaped, unlike /rest/* which is XML).
// GET /storage/scan/pending?source=<id>&limit=50
scanRoutes.get("/scan/pending", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const source = c.req.query("source") || "";
  if (!source) {
    return c.json({ ok: false, error: "Missing source parameter" }, 400);
  }
  // Cap at 500 so a malicious client can't tank D1; default 50 matches the
  // BROWSER READ batch size that runBrowserRead drives in Files.vue.
  const rawLimit = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 50;

  // Items not yet tag-scanned for this source. The partial index
  // idx_si_pending_scan keeps this O(matches).
  const rows = (await db.prepare(
    `SELECT id, master_id, source_id, storage_uri, suffix, size
     FROM song_instances
     WHERE source_id = ? AND tag_scanned = 0
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(source, limit).all<{
    id: string;
    master_id: string;
    source_id: string;
    storage_uri: string;
    suffix: string | null;
    size: number | null;
  }>()).results;

  // Also surface the total so Files.vue can render a real badge ("42 pending")
  // without having to fetch the full list when the user only wants the count.
  const totalRow = await db.prepare(
    "SELECT COUNT(*) AS n FROM song_instances WHERE source_id = ? AND tag_scanned = 0",
  ).bind(source).first<{ n: number }>();

  return c.json({
    ok: true,
    total: totalRow?.n ?? 0,
    items: rows.map((r) => ({
      instanceId: r.id,
      masterId: r.master_id,
      sourceId: r.source_id,
      storageUri: r.storage_uri,
      suffix: r.suffix || "",
      size: r.size ?? 0,
    })),
  });
});

// 093f — GET /storage/scan/listForMirror?source=<id>&offset=0&limit=100
// Returns song_instances for a given source that are NOT yet mirrored to R2
// (i.e. no sibling r2:// instance for the same master). The client iterates
// page by page and calls /storage/files/crossCopy per item, so the Worker
// never holds a long-running connection that could time out on large
// libraries. Permission: manage_sources (same as scan/start).
scanRoutes.get("/scan/listForMirror", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const source = c.req.query("source") || "";
  if (!source) return c.json({ ok: false, error: "Missing source parameter" }, 400);
  const rawLimit = parseInt(c.req.query("limit") || "100", 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;
  const rawOffset = parseInt(c.req.query("offset") || "0", 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  // Instances on the given source whose master has NO r2:// sibling.
  // We check via NOT EXISTS so the query stays indexed on source_id.
  const rows = (await db.prepare(
    `SELECT si.id, si.master_id, si.storage_uri, si.suffix, si.size, sm.title
     FROM song_instances si
     JOIN song_masters sm ON sm.id = si.master_id
     WHERE si.source_id = ? AND si.missing = 0
       AND NOT EXISTS (
         SELECT 1 FROM song_instances r2
         WHERE r2.master_id = si.master_id
           AND r2.storage_uri LIKE 'r2://%'
           AND r2.missing = 0
       )
     ORDER BY si.created_at ASC
     LIMIT ? OFFSET ?`,
  ).bind(source, limit, offset).all<{
    id: string; master_id: string; storage_uri: string; suffix: string | null;
    size: number | null; title: string | null;
  }>()).results;

  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS n
     FROM song_instances si
     WHERE si.source_id = ? AND si.missing = 0
       AND NOT EXISTS (
         SELECT 1 FROM song_instances r2
         WHERE r2.master_id = si.master_id
           AND r2.storage_uri LIKE 'r2://%'
           AND r2.missing = 0
       )`,
  ).bind(source).first<{ n: number }>();

  return c.json({
    ok: true,
    total: totalRow?.n ?? 0,
    offset,
    limit,
    items: rows.map((r) => ({
      instanceId: r.id,
      masterId: r.master_id,
      storageUri: r.storage_uri,
      suffix: r.suffix || "",
      size: r.size ?? 0,
      title: r.title || "",
    })),
  });
});

// Run the actual WebDAV scan for a single source. Updates scan_jobs progress
// every SCAN_PROGRESS_CHUNK files; sets status=completed | failed on exit.
//
// 051 — Incremental: each remote file is matched against its previous
// (source_etag, source_last_modified, size). When all three agree we skip the
// row entirely; when any differ we UPDATE the meta + reset tag_scanned=0 so
// the BROWSER READ queue (or Worker tag parser) re-reads the new bytes.
// When `etagCheck` is false (feature_strings.scan_etag_check='0') the skip
// path is disabled — every existing file gets the UPDATE + tag_scanned reset.
export async function asyncScanSource(
  db: D1Database,
  src: SourceRow,
  jobId: string,
  opts: { etagCheck?: boolean; dispatchToWorkerPool?: boolean } = {},
): Promise<void> {
  const queries = createQueries(db);
  const now = Math.floor(Date.now() / 1000);
  const etagCheck = opts.etagCheck !== false;            // default true
  // 052 — opt-in: when true and the row has tag_scanned=0 after the scan,
  // enqueue a `metadata` task. Off by default so existing callers
  // (scheduledScan etc) don't accidentally double-dispatch.
  const dispatchToWorkerPool = opts.dispatchToWorkerPool === true;
  // Collect instance ids that need a metadata parse (new INSERTs + changed
  // UPDATEs). We dispatch in one batch after the scan loop so the work_queue
  // INSERTs don't compete with the scan's UPDATE/INSERT batches.
  const dispatchTargets: Array<{ instanceId: string; uri: string; suffix: string; size: number }> = [];
  try {
    const { entries, complete } = await listWebdav(src);
    const audio = entries.filter((e) => !e.isDir && AUDIO_EXT.has(extOf(e.path)));

    // 051 — pull the prior snapshot (etag/lm/size/tag_scanned) for each
    // existing instance keyed by storage_uri. One query instead of N per-file
    // lookups so D1 reads stay bounded by the source's row count.
    const existingMap = new Map<string, ExistingRow>();
    {
      const rows = (await db.prepare(
        `SELECT id, storage_uri, source_etag, source_last_modified, size, tag_scanned
         FROM song_instances WHERE source_id = ?`,
      ).bind(src.id).all<{
        id: string;
        storage_uri: string;
        source_etag: string | null;
        source_last_modified: number | null;
        size: number | null;
        tag_scanned: number | null;
      }>()).results;
      for (const r of rows) {
        existingMap.set(r.storage_uri, {
          id: r.id,
          etag: r.source_etag,
          lastModified: r.source_last_modified,
          size: r.size,
          tagScanned: r.tag_scanned ?? 0,
        });
      }
    }

    await queries.updateScanJob(jobId, { totalItems: audio.length });

    const stmts: D1PreparedStatement[] = [];
    const touchedAlbums = new Set<string>();
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let scanned = 0;

    const flush = async () => {
      // Drain pending statements in 80-row chunks (D1 batch limit headroom).
      for (let i = 0; i < stmts.length; i += 80) {
        await db.batch(stmts.slice(i, i + 80));
      }
      stmts.length = 0;
      await queries.updateScanJob(jobId, { scannedItems: scanned });
    };

    for (const file of audio) {
      scanned++;
      const uri = `webdav://${src.id}/${file.path}`;
      const prior = existingMap.get(uri);

      // -------- Path 1: unchanged file → skip entirely --------
      // Triple-equal etag + lastModified + size. nulls are treated as
      // "unknown" — if the server stopped emitting an attribute the row
      // shouldn't be skipped (we'd lose the chance to recover meta).
      if (prior && etagCheck) {
        const etagSame = file.etag !== null && prior.etag !== null && file.etag === prior.etag;
        const lmSame = file.lastModified !== null && prior.lastModified !== null && file.lastModified === prior.lastModified;
        const sizeSame = prior.size === file.size;
        if (etagSame && lmSame && sizeSame) {
          skipped++;
          // 052 fix: file unchanged but if tag_scanned=0 (never read or 0021
          // backfilled before 052a) still enqueue metadata work so browsers
          // can drain the backlog. Without this, "orphan" rows that pre-date
          // the worker_queue would never be picked up by any scan iteration.
          if (dispatchToWorkerPool && prior.tagScanned === 0) {
            dispatchTargets.push({ instanceId: prior.id, uri, suffix: extOf(file.path), size: file.size });
          }
          if (scanned % SCAN_PROGRESS_CHUNK === 0) await flush();
          continue;
        }
      }

      // -------- Path 2: file changed → UPDATE existing row --------
      // Reset tag_scanned=0 so BROWSER READ / Worker tag parser re-reads it.
      // We deliberately don't touch master_id / song_masters; the tag rewrite
      // pass will move the master link if title/artist changed.
      if (prior) {
        stmts.push(
          db.prepare(
            `UPDATE song_instances
             SET source_etag = ?, source_last_modified = ?, size = ?,
                 content_type = ?, suffix = ?, tag_scanned = 0, updated_at = ?
             WHERE id = ?`,
          ).bind(
            file.etag,
            file.lastModified,
            file.size,
            file.contentType,
            extOf(file.path),
            now,
            prior.id,
          ),
        );
        updated++;
        if (dispatchToWorkerPool) {
          dispatchTargets.push({ instanceId: prior.id, uri, suffix: extOf(file.path), size: file.size });
        }
        if (scanned % SCAN_PROGRESS_CHUNK === 0) await flush();
        continue;
      }

      // -------- Path 3: brand new file → INSERT --------
      // 089 S2 — sync_only sources: scan tracks the file but does NOT write
      // artists/albums/song_masters/song_instances rows. `last_sync` and
      // scan_jobs progress counters are still updated so the scan appears
      // normal in the UI. Dispatch to the worker pool is also skipped (no
      // instance row means no metadata task target).
      if (src.mode === "sync_only") {
        added++;
        if (scanned % SCAN_PROGRESS_CHUNK === 0) await flush();
        continue;
      }

      const meta = guessFromPath(file.path);
      const artistId = "ar-" + md5(meta.artist).substring(0, 10);
      const albumId = "al-" + md5(meta.artist + " " + meta.album).substring(0, 10);
      const masterId = "sm-" + md5(uri).substring(0, 10);
      const instanceId = "si-" + md5(uri).substring(0, 10);
      touchedAlbums.add(albumId);

      stmts.push(
        db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(artistId, meta.artist, meta.artist.toLowerCase(), now, now),
        db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(albumId, meta.album, meta.album.toLowerCase(), now, now),
        db.prepare(
          `INSERT OR IGNORE INTO song_masters (id, album_id, artist_id, title, sort_title, track, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(masterId, albumId, artistId, meta.title, meta.title.toLowerCase(), meta.track, now, now),
        db.prepare(
          `INSERT OR IGNORE INTO song_instances
             (id, master_id, source_id, storage_uri, suffix, content_type, size,
              source_etag, source_last_modified, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          instanceId,
          masterId,
          src.id,
          uri,
          extOf(file.path),
          file.contentType,
          file.size,
          file.etag,
          file.lastModified,
          now,
          now,
        ),
      );
      added++;
      if (dispatchToWorkerPool) {
        dispatchTargets.push({ instanceId, uri, suffix: extOf(file.path), size: file.size });
      }

      if (scanned % SCAN_PROGRESS_CHUNK === 0) await flush();
    }
    // Mark these so eslint/tsc don't complain about unused locals — they're
    // surfaced via the scan_jobs error_message in the (rare) failure path.
    void updated; void skipped;

    // Final flush + recompute album song_count/size.
    await flush();

    for (const albumId of touchedAlbums) {
      await db.prepare(
        `UPDATE albums SET
           song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
           size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                   JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
           updated_at = ?
         WHERE id = ?`
      ).bind(albumId, albumId, now, albumId).run();
    }

    await db.prepare("UPDATE storage_sources SET last_sync = ? WHERE id = ?")
      .bind(now, src.id).run();

    // 052 — fan out metadata work to the browser worker pool. We do this
    // after the scan finishes writing rows so the work_queue inserts don't
    // contend with the source-of-truth UPSERTs. Failure is logged but does
    // not flip the scan_job to 'failed' — the queue is best-effort.
    if (dispatchToWorkerPool && dispatchTargets.length > 0) {
      try {
        await dispatchWorkBatch(db, dispatchTargets.map((t) => ({
          taskType: "metadata",
          payload: {
            instanceId: t.instanceId,
            sourceUri: t.uri,
            suffix: t.suffix,
            size: t.size,
          },
          requiredCaps: ["music-metadata"],
          priority: 5,
          // 076 — deterministic dedup key per instance. Re-running scan twice
          // (or hitting the existing-instance-with-tag_scanned=0 path on a
          // skipped row) now resolves to the same work_queue row instead of
          // piling up duplicates. Cleared once the task reaches a terminal
          // status — see done/fail handlers in work.ts.
          dedupKey: t.instanceId,
        })));
      } catch (e) {
        console.error(`[scan ${jobId}] dispatchWorkBatch failed:`, e);
      }
    }

    await queries.updateScanJob(jobId, {
      status: complete ? "completed" : "failed",
      scannedItems: scanned,
      totalItems: audio.length,
      endedAt: Math.floor(Date.now() / 1000),
      errorMessage: complete ? null : `Subrequest budget exhausted (added ${added})`,
    });
  } catch (e) {
    await queries.updateScanJob(jobId, {
      status: "failed",
      endedAt: Math.floor(Date.now() / 1000),
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.substring(i + 1).toLowerCase() : "";
}

// Heuristic: .../Artist/Album/NN Title.ext; fall back gracefully for flat layouts.
function guessFromPath(relPath: string): { artist: string; album: string; title: string; track: number | null } {
  const segs = relPath.split("/").filter(Boolean);
  const file = segs.pop() || relPath;
  const stem = file.replace(/\.[^.]+$/, "");
  const m = /^(\d{1,3})[\s._-]+(.+)$/.exec(stem);
  const track = m ? parseInt(m[1], 10) : null;
  const title = (m ? m[2] : stem).trim() || stem;
  const album = segs.length >= 1 ? segs[segs.length - 1] : "Unknown Album";
  const artist = segs.length >= 2 ? segs[segs.length - 2] : "Unknown Artist";
  return { artist, album, title, track };
}

async function listWebdav(
  src: SourceRow,
): Promise<{ entries: DavEntry[]; complete: boolean }> {
  const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
  const baseUrl = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const password = src.password || "";
  const auth = `Basic ${btoa(`${src.username || ""}:${password}`)}`;
  let requests = 0;

  const propfind = async (url: string, depth: "1" | "infinity"): Promise<Response> => {
    requests++;
    return fetch(url, {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: depth, "Content-Type": "application/xml" },
      // 051 — request getetag + getlastmodified so the incremental scanner can
      // decide whether to skip the row. Servers that don't support these props
      // still return the rest in the multistatus; parseMultistatus tolerates
      // missing tags by emitting null.
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>`,
    });
  };

  // Fast path: a single Depth:infinity request (many servers permit it)
  const deep = await propfind(baseUrl + "/", "infinity");
  if (deep.ok || deep.status === 207) {
    const text = await deep.text();
    return { entries: parseMultistatus(text, basePath), complete: true };
  }

  // Fallback: BFS with Depth:1, bounded by the subrequest budget
  const entries: DavEntry[] = [];
  const queue: string[] = [""];
  let complete = true;
  while (queue.length > 0) {
    if (requests >= MAX_DAV_REQUESTS) { complete = false; break; }
    const dir = queue.shift()!;
    const url = baseUrl + "/" + (dir ? encodePath(dir) + "/" : "");
    const resp = await propfind(url, "1");
    if (!resp.ok && resp.status !== 207) {
      if (dir === "") throw new Error(`PROPFIND failed: HTTP ${resp.status}`);
      continue;
    }
    const found = parseMultistatus(await resp.text(), basePath);
    for (const e of found) {
      if (e.path === dir || e.path === "") continue; // the collection itself
      entries.push(e);
      if (e.isDir) queue.push(e.path);
    }
  }
  return { entries, complete };
}

export function parseMultistatus(xml: string, basePath: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const blocks = xml.split(/<(?:[A-Za-z][\w-]*:)?response[ >]/).slice(1);
  for (const block of blocks) {
    const hrefM = /<(?:[A-Za-z][\w-]*:)?href[^>]*>([^<]+)<\/(?:[A-Za-z][\w-]*:)?href>/.exec(block);
    if (!hrefM) continue;
    let href = hrefM[1].trim();
    try {
      // href may be absolute URL or absolute path
      if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
      href = decodeURIComponent(href);
    } catch { /* keep raw */ }
    href = stripTrailingSlash(href);
    let rel = href.startsWith(basePath) ? href.substring(basePath.length) : href;
    rel = rel.replace(/^\/+/, "");

    const isDir = /<(?:[A-Za-z][\w-]*:)?collection\b/.test(block);
    const sizeM = /<(?:[A-Za-z][\w-]*:)?getcontentlength[^>]*>(\d+)</.exec(block);
    const typeM = /<(?:[A-Za-z][\w-]*:)?getcontenttype[^>]*>([^<]+)</.exec(block);
    // 051 — getetag is usually quoted (`"abc-123"`). Strip the wrapping quotes
    // so equality compares the raw tag instead of `"x"` vs `x`.
    const etagM = /<(?:[A-Za-z][\w-]*:)?getetag[^>]*>([^<]+)</.exec(block);
    const lmM = /<(?:[A-Za-z][\w-]*:)?getlastmodified[^>]*>([^<]+)</.exec(block);
    let etag: string | null = null;
    if (etagM) {
      etag = etagM[1].trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
      if (!etag) etag = null;
    }
    // getlastmodified is RFC 1123/822 in practice; Date.parse handles both that
    // and ISO 8601. Anything unparseable becomes null (we'd rather skip the
    // signal than store a NaN/0).
    let lastModified: number | null = null;
    if (lmM) {
      const t = Date.parse(lmM[1].trim());
      if (Number.isFinite(t)) lastModified = Math.floor(t / 1000);
    }

    entries.push({
      path: rel,
      isDir,
      size: sizeM ? parseInt(sizeM[1], 10) : 0,
      contentType: typeM ? typeM[1].trim() : null,
      etag,
      lastModified,
    });
  }
  return entries;
}

export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
