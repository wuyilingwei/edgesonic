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
import { permissionMiddleware } from "../../auth";
import { md5 } from "../../utils/md5";
import { createQueries } from "../../db/queries";

type Queries = ReturnType<typeof createQueries>;
import { requiredPrefixLen, rebuildTagPrefix } from "../../utils/tagwrite";
import type { TagWriteCover } from "../../utils/tagwrite";
import { encodePath } from "../storage/scan";
import type { SongTags } from "../../utils/tags";

export const tagEditRoutes = new Hono();

const HEAD_FETCH = 512 * 1024;
const MAX_REWRITE_BYTES = 80 * 1024 * 1024; // whole file is buffered for the rewrite
const MAX_COVER_BYTES = 500 * 1024;          // 042 — front cover ceiling; the web canvas compressor honours this
const BATCH_MAX = 50; // Workers single-request CPU budget bounds batch fan-out (see findings.md)

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

interface FileResult {
  instanceId: string;
  uri: string;
  written: boolean;
  reason?: string;
}

interface ApplyResult {
  ok: boolean;
  masterId?: string;
  albumId?: string;
  artistId?: string;
  files?: FileResult[];
  error?: string;
}

// ============================================================================
// POST /rest/writeTags  body: { id: <masterId|instanceId>, tags: SongTags }
// Single-song edit. The batch endpoint reuses applyTagsToSong below.
// ============================================================================
tagEditRoutes.post("/write", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{ id?: string; tags?: SongTags; coverData?: string; coverMime?: string }>().catch(() => null);
  if (!body?.id || !body.tags) return c.json({ ok: false, error: "Missing id or tags" }, 400);

  const tags = cleanInput(body.tags);
  const parsed = parseCover(body.coverData, body.coverMime);
  if (parsed && "error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
  const cover = parsed ?? undefined;
  // tag fields are optional when a cover is provided — cover-only edits still legitimately update the file
  if (!Object.keys(tags).length && !cover) return c.json({ ok: false, error: "No tag fields provided" }, 400);

  const sources = await loadSources(db);
  const res = await applyTagsToSong(env, db, queries, sources, body.id, tags, cover);
  if (!res.ok) {
    const status = res.error === "Song not found" ? 404 : 500;
    return c.json({ ok: false, error: res.error || "Write failed" }, status);
  }
  return c.json({
    ok: true,
    masterId: res.masterId,
    albumId: res.albumId,
    artistId: res.artistId,
    files: res.files,
  });
});

// ============================================================================
// POST /rest/batchWriteTags  body: { ids: string[], patch: Partial<SongTags> }
// Applies the same tag patch to up to BATCH_MAX songs; per-song results.
// ============================================================================
tagEditRoutes.post("/batchWrite", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{ ids?: string[]; patch?: SongTags; coverData?: string; coverMime?: string }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || !body.patch) {
    return c.json({ ok: false, error: "Missing ids or patch" }, 400);
  }
  if (body.ids.length === 0) return c.json({ ok: false, error: "Empty ids" }, 400);
  if (body.ids.length > BATCH_MAX) {
    return c.json({ ok: false, error: `Batch size exceeds limit (${BATCH_MAX})` }, 400);
  }

  const patch = cleanInput(body.patch);
  const parsed = parseCover(body.coverData, body.coverMime);
  if (parsed && "error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
  const cover = parsed ?? undefined;
  if (!Object.keys(patch).length && !cover) {
    return c.json({ ok: false, error: "Patch contains no recognised fields" }, 400);
  }

  const sources = await loadSources(db);
  const results: Array<{
    id: string;
    ok: boolean;
    masterId?: string;
    error?: string;
    files?: FileResult[];
  }> = [];
  let succeeded = 0;
  let failed = 0;

  // Sequential: keeps D1 contention low and stays within the Workers CPU budget
  // for a 50-item burst. Each entry is independent — one bad id never poisons
  // the others; per-row error string lands on the failed result.
  for (const id of body.ids) {
    try {
      const res = await applyTagsToSong(env, db, queries, sources, id, patch, cover);
      if (res.ok) {
        succeeded++;
        results.push({ id, ok: true, masterId: res.masterId, files: res.files });
      } else {
        failed++;
        results.push({ id, ok: false, error: res.error || "Write failed" });
      }
    } catch (e) {
      failed++;
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({ ok: true, results, succeeded, failed });
});

// ============================================================================
// Core: apply a tag patch to a single song (D1 relink + per-instance file write).
// Used by both writeTags (single) and batchWriteTags (loop).
// ============================================================================
async function applyTagsToSong(
  env: Env,
  db: D1Database,
  queries: Queries,
  sources: Map<string, SourceRow>,
  idOrInstanceId: string,
  tags: SongTags,
  cover?: TagWriteCover,
): Promise<ApplyResult> {
  let master = await queries.getSongMaster(idOrInstanceId);
  if (!master) {
    const inst = await queries.getSongInstance(idOrInstanceId);
    if (inst) master = await queries.getSongMaster(inst.master_id);
  }
  if (!master) return { ok: false, error: "Song not found" };

  // --- D1 relink (same id derivation as scanTags so edits and scans converge) ---
  // Cover-only edits skip D1 mutation entirely — there is no field to relink.
  if (!Object.keys(tags).length && cover) {
    const instances = await queries.getSongInstances(master.id);
    const files: FileResult[] = [];
    for (const inst of instances) {
      const res = await rewriteInstance(env, sources, inst.storage_uri, (inst.suffix || "").toLowerCase(), inst.content_type, tags, cover)
        .catch((e): { written: boolean; reason?: string; newSize?: number } =>
          ({ written: false, reason: e instanceof Error ? e.message : String(e) }));
      if (res.written && typeof res.newSize === "number") {
        await db.prepare("UPDATE song_instances SET size = ?, updated_at = ? WHERE id = ?")
          .bind(res.newSize, Math.floor(Date.now() / 1000), inst.id).run();
      }
      files.push({ instanceId: inst.id, uri: inst.storage_uri, written: res.written, reason: res.reason });
    }
    return { ok: true, masterId: master.id, albumId: master.album_id, artistId: master.artist_id, files };
  }

  const curArtist = await db.prepare("SELECT name FROM artists WHERE id = ?")
    .bind(master.artist_id).first<{ name: string }>();
  const curAlbum = await db.prepare("SELECT name FROM albums WHERE id = ?")
    .bind(master.album_id).first<{ name: string }>();

  const title = tags.title || master.title;
  const artistName = tags.artist || curArtist?.name || "Unknown Artist";
  const linkArtistName = tags.albumArtist || artistName;
  const albumName = tags.album || curAlbum?.name || "Unknown Album";
  const artistId = "ar-" + md5(linkArtistName).substring(0, 10);
  const albumId = "al-" + md5(linkArtistName + " " + albumName).substring(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const oldAlbumId = master.album_id;

  await db.batch([
    db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(artistId, linkArtistName, linkArtistName.toLowerCase(), now, now),
    db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, tags.genre ?? null, now, now),
    db.prepare(
      `UPDATE song_masters SET
         album_id = ?, artist_id = ?, title = ?, sort_title = ?,
         track = COALESCE(?, track), genre = COALESCE(?, genre),
         lyrics = COALESCE(?, lyrics), updated_at = ?
       WHERE id = ?`
    ).bind(albumId, artistId, title, title.toLowerCase(), tags.track ?? null, tags.genre ?? null, tags.lyrics ?? null, now, master.id),
    // manual edits win over future scans
    db.prepare("UPDATE song_instances SET tag_scanned = 1 WHERE master_id = ?").bind(master.id),
  ]);
  if (tags.year || tags.genre) {
    await db.prepare("UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?")
      .bind(tags.year ?? null, tags.genre ?? null, now, albumId).run();
  }

  // refresh aggregates for both the new and the vacated album, then sweep empties
  for (const aid of new Set([albumId, oldAlbumId])) {
    await db.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
         size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                 JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
         updated_at = ?
       WHERE id = ?`
    ).bind(aid, aid, now, aid).run();
  }
  await db.prepare("DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id)").run();
  await db.prepare(
    "DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id)"
  ).run();

  // --- file write-back per instance ---
  const instances = await queries.getSongInstances(master.id);
  const files: FileResult[] = [];
  for (const inst of instances) {
    const res = await rewriteInstance(env, sources, inst.storage_uri, (inst.suffix || "").toLowerCase(), inst.content_type, tags, cover)
      .catch((e): { written: boolean; reason?: string; newSize?: number } =>
        ({ written: false, reason: e instanceof Error ? e.message : String(e) }));
    if (res.written && typeof res.newSize === "number") {
      await db.prepare("UPDATE song_instances SET size = ?, updated_at = ? WHERE id = ?")
        .bind(res.newSize, now, inst.id).run();
    }
    files.push({ instanceId: inst.id, uri: inst.storage_uri, written: res.written, reason: res.reason });
  }

  return { ok: true, masterId: master.id, albumId, artistId, files };
}

async function loadSources(db: D1Database): Promise<Map<string, SourceRow>> {
  const sources = new Map<string, SourceRow>();
  const rows = await db.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE enabled = 1"
  ).all<SourceRow>();
  for (const s of rows.results) sources.set(s.id, s);
  return sources;
}

// Validate + decode `coverData` (base64) and `coverMime` from the request body.
// Returns null when no cover was supplied, a TagWriteCover on success, or an
// { error } envelope so the caller can pass it through to a 400 response.
function parseCover(coverData?: string, coverMime?: string): TagWriteCover | { error: string } | null {
  if (!coverData) return null;
  const mime = (coverMime || "image/jpeg").toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png") {
    return { error: `Unsupported cover mime: ${mime}` };
  }
  const data = decodeBase64(coverData);
  if (!data) return { error: "Invalid base64 coverData" };
  if (data.length > MAX_COVER_BYTES) {
    return { error: `Cover exceeds ${MAX_COVER_BYTES} bytes (${data.length})` };
  }
  if (data.length === 0) return { error: "Empty cover data" };
  return { mime, data };
}

function decodeBase64(s: string): Uint8Array | null {
  try {
    // strip whitespace + optional data URL prefix the UI may forward
    const clean = s.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// 036 — D1 lyric payload ceiling. A reasonable LRC is < 8 KB; we leave plenty
// of headroom for plain-text translations / annotations while keeping a single
// row well under D1's per-row limit.
const MAX_LYRICS_BYTES = 50 * 1024;

function cleanInput(t: SongTags): SongTags {
  const out: SongTags = {};
  if (t.title?.trim()) out.title = t.title.trim();
  if (t.artist?.trim()) out.artist = t.artist.trim();
  if (t.album?.trim()) out.album = t.album.trim();
  if (t.albumArtist?.trim()) out.albumArtist = t.albumArtist.trim();
  if (t.genre?.trim()) out.genre = t.genre.trim();
  const track = Number(t.track), year = Number(t.year);
  if (Number.isInteger(track) && track > 0) out.track = track;
  if (Number.isInteger(year) && year > 0) out.year = year;
  // 036 — lyrics: trim, cap, drop silently if oversized so a single bad payload
  // doesn't poison a batch. File-level write-back (USLT / VORBIS LYRICS) is
  // deferred to 042; this path is D1-only for v1.
  if (typeof t.lyrics === "string") {
    const trimmed = t.lyrics.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_LYRICS_BYTES) {
      out.lyrics = trimmed;
    }
  }
  return out;
}

async function rewriteInstance(
  env: Env,
  sources: Map<string, SourceRow>,
  uri: string,
  suffix: string,
  contentType: string | null,
  tags: SongTags,
  cover?: TagWriteCover,
): Promise<{ written: boolean; reason?: string; newSize?: number }> {
  if (suffix !== "mp3" && suffix !== "flac") return { written: false, reason: `format .${suffix} not rewritable` };

  if (uri.startsWith("r2://")) {
    const key = uri.substring(5);
    const headObj = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: HEAD_FETCH } });
    if (!headObj) return { written: false, reason: "object not found" };
    const meta = await env.MUSIC_BUCKET.head(key);
    const totalSize = meta?.size ?? 0;
    if (totalSize > MAX_REWRITE_BYTES) return { written: false, reason: "file too large to rewrite" };

    let head = new Uint8Array(await headObj.arrayBuffer());
    const need = requiredPrefixLen(head, suffix);
    if (need === null) return { written: false, reason: "unsupported tag layout" };
    if (need > head.length) {
      const bigger = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: need } });
      if (!bigger) return { written: false, reason: "object not found" };
      head = new Uint8Array(await bigger.arrayBuffer());
    }
    const rw = rebuildTagPrefix(head, suffix, tags, cover);
    if (!rw) return { written: false, reason: "unsupported tag layout" };

    const restLen = totalSize - rw.oldPrefixLen;
    const out = new Uint8Array(rw.newPrefix.length + restLen);
    out.set(rw.newPrefix, 0);
    if (restLen > 0) {
      const rest = await env.MUSIC_BUCKET.get(key, { range: { offset: rw.oldPrefixLen } });
      if (!rest) return { written: false, reason: "object not found" };
      out.set(new Uint8Array(await rest.arrayBuffer()), rw.newPrefix.length);
    }
    await env.MUSIC_BUCKET.put(key, out, {
      httpMetadata: meta?.httpMetadata || { contentType: contentType || "application/octet-stream" },
    });
    return { written: true, newSize: out.length };
  }

  if (uri.startsWith("webdav://")) {
    const rest = uri.substring(9);
    const slash = rest.indexOf("/");
    const src = sources.get(rest.substring(0, slash));
    if (!src) return { written: false, reason: "source not found or disabled" };
    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const url = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "") + "/" + encodePath(rest.substring(slash + 1));
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;

    // WebDAV has no cheap prefix swap — fetch the whole file, rewrite, PUT back
    const resp = await fetch(url, { headers: { Authorization: auth } });
    if (!resp.ok) return { written: false, reason: `GET failed: HTTP ${resp.status}` };
    const len = parseInt(resp.headers.get("Content-Length") || "0", 10);
    if (len > MAX_REWRITE_BYTES) {
      await resp.body?.cancel();
      return { written: false, reason: "file too large to rewrite" };
    }
    const whole = new Uint8Array(await resp.arrayBuffer());
    if (whole.length > MAX_REWRITE_BYTES) return { written: false, reason: "file too large to rewrite" };

    const need = requiredPrefixLen(whole, suffix);
    if (need === null || need > whole.length) return { written: false, reason: "unsupported tag layout" };
    const rw = rebuildTagPrefix(whole, suffix, tags);
    if (!rw) return { written: false, reason: "unsupported tag layout" };

    const out = new Uint8Array(rw.newPrefix.length + (whole.length - rw.oldPrefixLen));
    out.set(rw.newPrefix, 0);
    out.set(whole.subarray(rw.oldPrefixLen), rw.newPrefix.length);

    const put = await fetch(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": contentType || "application/octet-stream" },
      body: out,
    });
    if (!put.ok) return { written: false, reason: `PUT failed: HTTP ${put.status}` };
    return { written: true, newSize: out.length };
  }

  return { written: false, reason: "read-only source" };
}
