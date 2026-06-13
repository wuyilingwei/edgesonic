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

import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { md5 } from "../../utils/md5";
import { createQueries } from "../../db/queries";

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
}

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
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
    `SELECT id, base_url, username, password, root_path FROM storage_sources
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

  // ctx.waitUntil keeps the Worker alive until the scan finishes (subject to
  // platform CPU/wall caps); the response below returns right away.
  const exec = c.executionCtx;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const src = sources[i];
    exec.waitUntil(asyncScanSource(db, src, job.id));
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

// Run the actual WebDAV scan for a single source. Updates scan_jobs progress
// every SCAN_PROGRESS_CHUNK files; sets status=completed | failed on exit.
async function asyncScanSource(db: D1Database, src: SourceRow, jobId: string): Promise<void> {
  const queries = createQueries(db);
  const now = Math.floor(Date.now() / 1000);
  try {
    const { entries, complete } = await listWebdav(src);
    const audio = entries.filter((e) => !e.isDir && AUDIO_EXT.has(extOf(e.path)));

    // Skip files already registered for this source
    const existing = new Set(
      (await db.prepare("SELECT storage_uri FROM song_instances WHERE source_id = ?")
        .bind(src.id).all<{ storage_uri: string }>()).results.map((r) => r.storage_uri)
    );

    await queries.updateScanJob(jobId, { totalItems: audio.length });

    const stmts: D1PreparedStatement[] = [];
    const touchedAlbums = new Set<string>();
    let added = 0;
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
      if (existing.has(uri)) {
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
          `INSERT OR IGNORE INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(instanceId, masterId, src.id, uri, extOf(file.path), file.contentType, file.size, now, now),
      );
      added++;

      if (scanned % SCAN_PROGRESS_CHUNK === 0) await flush();
    }

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

async function listWebdav(src: SourceRow): Promise<{ entries: DavEntry[]; complete: boolean }> {
  const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
  const baseUrl = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;
  let requests = 0;

  const propfind = async (url: string, depth: "1" | "infinity"): Promise<Response> => {
    requests++;
    return fetch(url, {
      method: "PROPFIND",
      headers: { Authorization: auth, Depth: depth, "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>`,
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

    entries.push({
      path: rel,
      isDir,
      size: sizeM ? parseInt(sizeM[1], 10) : 0,
      contentType: typeM ? typeM[1].trim() : null,
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
