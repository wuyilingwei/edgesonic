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

// ============================================================================
// 041 — POST /rest/submitMetadata
// ----------------------------------------------------------------------------
// 浏览器侧已经用 music-metadata 解析过一个本地音频文件，把解析结果发回来落 D1：
//   * 用 instanceId 反查 master_id
//   * 重链 artist/album（与 scanTags 派生方式一致：md5(name) 前 10 位）
//   * 更新 song_masters 的逻辑字段
//   * 更新 song_instances 的物理参数（bit_rate/sample_rate/channels/duration）
//   * 标记 tag_scanned = 1
//
// 设计原则：
//   * 不调用 worker/src/utils/tags.ts → 041 的核心动机就是节约 Workers CPU
//   * 不复用 tagedit.applyTagsToSong → 那条路径会 rewriteInstance 强写文件，041 只落 D1
// ============================================================================

import { Hono } from "hono";
import { permissionMiddleware } from "../auth";
import { md5 } from "../utils/md5";

export const metadataRoutes = new Hono();

// Browser-extracted metadata payload — duplicated here (and in web/src/lib/metadata.ts)
// so the worker doesn't need to import a web-only module. Keep both in sync.
export interface SubmittedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  track?: number;
  disc?: number;
  duration?: number;     // seconds
  bitrate?: number;      // kbps
  sampleRate?: number;   // Hz
  channels?: number;
  lyrics?: string;       // accepted but NOT persisted (song_masters has no lyrics column yet — 036)
  container?: string;
  codec?: string;
}

// ============================================================================
// GET /rest/findInstanceByUri?uri=r2://...|webdav://...
// ----------------------------------------------------------------------------
// Files.vue lists files by storage_uri; the browser-side scanner needs the
// matching song_instances.id to POST submitMetadata against. We expose a
// minimal lookup (exact match on storage_uri) instead of teaching the front-
// end to learn the master→instance relationship through Subsonic browsing.
// ============================================================================
metadataRoutes.get("/rest/findInstanceByUri", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  const uri = c.req.query("uri");
  if (!uri) return c.json({ ok: false, error: "Missing uri" }, 400);
  const row = await env.DB.prepare(
    "SELECT id, master_id, suffix, tag_scanned FROM song_instances WHERE storage_uri = ?"
  ).bind(uri).first<{ id: string; master_id: string; suffix: string; tag_scanned: number }>();
  if (!row) return c.json({ ok: false, error: "Instance not found" }, 404);
  return c.json({
    ok: true,
    instanceId: row.id,
    masterId: row.master_id,
    suffix: row.suffix,
    tagScanned: row.tag_scanned,
  });
});

metadataRoutes.post("/rest/submitMetadata", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;

  const body = await c.req.json<{ instanceId?: string; tags?: SubmittedMetadata }>().catch(() => null);
  if (!body?.instanceId || !body.tags) {
    return c.json({ ok: false, error: "Missing instanceId or tags" }, 400);
  }

  const tags = cleanInput(body.tags);
  // At least one usable logical field must survive — otherwise we'd just bump
  // tag_scanned without learning anything (and a future scan couldn't retry).
  if (!hasAnyLogical(tags)) {
    return c.json({ ok: false, error: "No usable tag fields" }, 400);
  }

  const inst = await db.prepare(
    "SELECT id, master_id FROM song_instances WHERE id = ?"
  ).bind(body.instanceId).first<{ id: string; master_id: string }>();
  if (!inst) return c.json({ ok: false, error: "Instance not found" }, 400);

  const master = await db.prepare(
    "SELECT id, album_id, artist_id, title FROM song_masters WHERE id = ?"
  ).bind(inst.master_id).first<{ id: string; album_id: string; artist_id: string; title: string }>();
  if (!master) return c.json({ ok: false, error: "Master not found" }, 500);

  const res = await relinkArtistAlbum(db, master, tags);

  // Update physical params on the instance row (only the fields the browser gave us).
  const instSets: string[] = [];
  const instBinds: unknown[] = [];
  if (typeof tags.bitrate === "number")    { instSets.push("bit_rate = ?");    instBinds.push(tags.bitrate); }
  if (typeof tags.sampleRate === "number") { instSets.push("sample_rate = ?"); instBinds.push(tags.sampleRate); }
  if (typeof tags.channels === "number")   { instSets.push("channels = ?");    instBinds.push(tags.channels); }
  if (typeof tags.duration === "number")   { instSets.push("duration = ?");    instBinds.push(tags.duration); }
  instSets.push("tag_scanned = 1");
  instSets.push("updated_at = ?");
  instBinds.push(Math.floor(Date.now() / 1000));
  instBinds.push(inst.id);
  await db.prepare(`UPDATE song_instances SET ${instSets.join(", ")} WHERE id = ?`)
    .bind(...instBinds).run();

  return c.json({
    ok: true,
    masterId: master.id,
    albumId: res.albumId,
    artistId: res.artistId,
  });
});

// ============================================================================
// Exported helper — used by submitMetadata above. Mirrors the relink core of
// scanTags / applyTagsToSong but skips file rewrites entirely.
// ============================================================================
export async function relinkArtistAlbum(
  db: D1Database,
  master: { id: string; album_id: string; artist_id: string; title: string },
  tags: SubmittedMetadata,
): Promise<{ albumId: string; artistId: string }> {
  const now = Math.floor(Date.now() / 1000);

  // Look up the current artist/album names so we can keep them when the patch
  // omits the field (same fallback chain as tagedit.ts).
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
  const oldAlbumId = master.album_id;

  await db.batch([
    db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(artistId, linkArtistName, linkArtistName.toLowerCase(), now, now),
    db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, tags.genre ?? null, now, now),
    db.prepare(
      `UPDATE song_masters SET
         album_id = ?, artist_id = ?, title = ?, sort_title = ?,
         track = COALESCE(?, track), disc = COALESCE(?, disc),
         genre = COALESCE(?, genre), duration = COALESCE(?, duration),
         updated_at = ?
       WHERE id = ?`
    ).bind(
      albumId, artistId, title, title.toLowerCase(),
      tags.track ?? null, tags.disc ?? null,
      tags.genre ?? null, tags.duration ?? null,
      now, master.id,
    ),
  ]);

  // Backfill year / genre onto the freshly anchored album row (INSERT OR IGNORE
  // above skipped them when the row already existed).
  if (tags.year || tags.genre) {
    await db.prepare("UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?")
      .bind(tags.year ?? null, tags.genre ?? null, now, albumId).run();
  }

  // Refresh aggregates for both the new and the vacated album, then sweep empties.
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

  return { albumId, artistId };
}

// ============================================================================
// Input scrubbing — same shape as tagedit.cleanInput, plus the 041-only fields.
// ============================================================================
function cleanInput(t: SubmittedMetadata): SubmittedMetadata {
  const out: SubmittedMetadata = {};
  if (t.title?.trim())       out.title       = t.title.trim();
  if (t.artist?.trim())      out.artist      = t.artist.trim();
  if (t.album?.trim())       out.album       = t.album.trim();
  if (t.albumArtist?.trim()) out.albumArtist = t.albumArtist.trim();
  if (t.genre?.trim())       out.genre       = t.genre.trim();

  const track = Number(t.track), year = Number(t.year), disc = Number(t.disc);
  if (Number.isInteger(track) && track > 0) out.track = track;
  if (Number.isInteger(year)  && year  > 0) out.year  = year;
  if (Number.isInteger(disc)  && disc  > 0) out.disc  = disc;

  // physical params: any positive finite number is fine
  if (Number.isFinite(t.duration)   && (t.duration   as number) > 0) out.duration   = t.duration;
  if (Number.isFinite(t.bitrate)    && (t.bitrate    as number) > 0) out.bitrate    = t.bitrate;
  if (Number.isFinite(t.sampleRate) && (t.sampleRate as number) > 0) out.sampleRate = t.sampleRate;
  if (Number.isFinite(t.channels)   && (t.channels   as number) > 0) out.channels   = t.channels;

  // lyrics + container/codec: accept-but-not-persist (kept on payload for future 036 plumbing)
  if (t.lyrics?.trim())    out.lyrics    = t.lyrics.trim();
  if (t.container?.trim()) out.container = t.container.trim();
  if (t.codec?.trim())     out.codec     = t.codec.trim();
  return out;
}

function hasAnyLogical(t: SubmittedMetadata): boolean {
  return !!(t.title || t.artist || t.album || t.albumArtist || t.genre || t.year || t.track || t.disc);
}
