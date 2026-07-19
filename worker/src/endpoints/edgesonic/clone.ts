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
// The browser drives the clone (see web/src/views/Settings.vue "Clone
// Subsonic server" sub-block): it fetches metadata + bytes directly from
// the upstream Subsonic server and POSTs each item here to be persisted
// locally. Keeping the loop client-side avoids Worker CPU-time timeouts
// when the upstream library is large.
//
// All endpoints live under /edgesonic/clone/* behind authMiddleware (path
// prefix /edgesonic/ → web session only). Per-endpoint authorisation is
// graded (176):
//  * upsertMaster / ingestAudio / fetchAudioToR2 — manage_users (writes to the
//    shared library / R2).
//  * upsertUser — super admin only (clone-all-users provisions accounts).
//  * upsertStarred / upsertPlaylist — any authenticated user MAY write to their
//    OWN account; writing to a different target user requires manage_users
//    (enforced in-handler via resolveTargetUser).
//  * proxy — any authenticated user (server-side upstream fetch; SSRF surface
//    accepted by design so non-admins can read the upstream they clone from).
//
// Persistence is INSERT OR IGNORE for entity tables (artists/albums/
// song_masters) so a re-clone is a no-op; annotations / playlists /
// users / credentials use UPSERT so re-cloning refreshes the local copy.

import { Hono } from "hono";
import { md5 } from "../../utils/md5";
import { GUEST_USERNAME, permissionMiddleware, sha256 } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import type { User } from "../../types/entities";
import type { Context } from "hono";
import { artistInsertStatements, parseArtistCredits, songArtistStatements } from "../../utils/artistCredits";

export const cloneRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const DEFAULT_CLONE_SOURCE_KEY = "default";
const METADATA_SEPARATOR_RE = /[,，;；\/]+/g;

type CloneSongRef = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  duration?: number | null;
  track?: number | null;
  disc?: number | null;
};

type CloneItemRef = CloneSongRef & {
  id: string;
  type: "song" | "album" | "artist";
  name?: string;
  year?: number | null;
  songCount?: number | null;
  starredAt?: number | null;
};

interface LocalSongMatchRow {
  id: string;
  title: string;
  duration: number | null;
  track: number | null;
  disc: number | null;
  album_name: string;
  artist_name: string;
}

interface LocalAlbumMatchRow {
  id: string;
  name: string;
  year: number | null;
  song_count: number | null;
  duration: number | null;
  artist_name: string | null;
}

interface LocalArtistMatchRow {
  id: string;
  name: string;
}

function normMatch(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(METADATA_SEPARATOR_RE, " ").replace(/\s+/g, " ");
}

function normFuzzy(s: string | null | undefined): string {
  return normMatch(s)
    .replace(/[#＃]\s*\d+\s*/g, " ")
    .replace(/^\s*\d{1,3}\s*[-–—_.、．:：)）]\s*/, "")
    .replace(/^\s*\d{1,3}\s+/, "")
    .replace(/[([（【].*?[)\]）】]/g, " ")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function fuzzyCompatible(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function isUnknownArtistName(raw: string | null | undefined): boolean {
  const normalized = normFuzzy(raw);
  return normalized === "unknownartist" || normalized === "未知艺术家" || normalized === "未知藝術家";
}

function artistTokens(raw: string | null | undefined): string[] {
  return normMatch(raw)
    .split(" ")
    .map((part) => normFuzzy(part))
    .filter(Boolean);
}

function artistsCompatible(existingArtist: string | null | undefined, incomingArtist: string | null | undefined): boolean {
  const existingF = normFuzzy(existingArtist);
  const incomingF = normFuzzy(incomingArtist);
  if (fuzzyCompatible(existingF, incomingF)) return true;
  if (isUnknownArtistName(existingArtist) && isUnknownArtistName(incomingArtist)) return true;
  const existingTokens = artistTokens(existingArtist);
  const incomingTokens = artistTokens(incomingArtist);
  if (!existingTokens.length || !incomingTokens.length) return false;
  return incomingTokens.every((token) => existingTokens.includes(token)) || existingTokens.every((token) => incomingTokens.includes(token));
}

function cloneNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasSongMetadata(ref: CloneSongRef): boolean {
  return !!ref.title?.trim() && !!ref.album?.trim() && !!ref.artist?.trim();
}

function hasAlbumMetadata(ref: CloneItemRef): boolean {
  return !!(ref.name || ref.album)?.trim();
}

function hasArtistMetadata(ref: CloneItemRef): boolean {
  return !!(ref.name || ref.artist)?.trim();
}

function chooseSongCandidate(
  candidates: LocalSongMatchRow[],
  ref: CloneSongRef,
): string | null {
  if (candidates.length === 0) return null;
  let narrowed = candidates;

  if (ref.duration != null) {
    const durationMatches = candidates.filter((row) => row.duration == null || Math.abs(row.duration - ref.duration!) <= 3);
    if (durationMatches.length === 0) return null;
    if (durationMatches.length < narrowed.length) narrowed = durationMatches;
  }

  if (ref.disc != null || ref.track != null) {
    const positionMatches = narrowed.filter((row) =>
      (ref.disc == null || row.disc == null || row.disc === ref.disc) &&
      (ref.track == null || row.track == null || row.track === ref.track),
    );
    if (positionMatches.length > 0 && positionMatches.length < narrowed.length) narrowed = positionMatches;
  }

  return narrowed.length === 1 ? narrowed[0].id : null;
}

function matchSongByName(rows: LocalSongMatchRow[], ref: CloneSongRef): string | null {
  if (!hasSongMetadata(ref)) return null;
  const title = normMatch(ref.title);
  const album = normMatch(ref.album);
  const artist = ref.artist || ref.albumArtist || "";
  const exact = rows.filter((row) =>
    normMatch(row.title) === title &&
    normMatch(row.album_name) === album &&
    artistsCompatible(row.artist_name, artist),
  );
  const exactMatch = chooseSongCandidate(exact, ref);
  if (exactMatch) return exactMatch;

  const titleF = normFuzzy(ref.title);
  const albumF = normFuzzy(ref.album);
  const fuzzy = rows.filter((row) =>
    normFuzzy(row.title) === titleF &&
    normFuzzy(row.album_name) === albumF &&
    artistsCompatible(row.artist_name, artist),
  );
  return chooseSongCandidate(fuzzy, ref);
}

function matchAlbumByName(rows: LocalAlbumMatchRow[], ref: CloneItemRef): string | null {
  const name = ref.name || ref.album || "";
  if (!name.trim()) return null;
  const nameN = normMatch(name);
  const artist = ref.artist || ref.albumArtist || "";
  let candidates = rows.filter((row) => normMatch(row.name) === nameN);
  if (artist) candidates = candidates.filter((row) => !row.artist_name || artistsCompatible(row.artist_name, artist));
  if (candidates.length === 0) {
    const nameF = normFuzzy(name);
    candidates = rows.filter((row) => normFuzzy(row.name) === nameF);
    if (artist) candidates = candidates.filter((row) => !row.artist_name || artistsCompatible(row.artist_name, artist));
  }
  if (candidates.length === 0) return null;

  const scored = candidates.map((row) => {
    let score = 0;
    if (ref.year != null && row.year === ref.year) score += 3;
    if (ref.songCount != null && row.song_count === ref.songCount) score += 2;
    if (ref.duration != null && row.duration != null && Math.abs(row.duration - ref.duration) <= 3) score += 2;
    if (artist && row.artist_name && normMatch(row.artist_name) === normMatch(artist)) score += 1;
    return { row, score };
  });
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore);
  return best.length === 1 ? best[0].row.id : null;
}

function matchArtistByName(rows: LocalArtistMatchRow[], ref: CloneItemRef): string | null {
  const name = ref.name || ref.artist || "";
  if (!name.trim()) return null;
  const exact = rows.filter((row) => normMatch(row.name) === normMatch(name));
  if (exact.length === 1) return exact[0].id;
  const fuzzy = rows.filter((row) => normFuzzy(row.name) === normFuzzy(name));
  return fuzzy.length === 1 ? fuzzy[0].id : null;
}

async function loadLocalSongMatchRows(db: D1Database): Promise<LocalSongMatchRow[]> {
  const result = await db.prepare(
    `SELECT sm.id, sm.title, sm.duration, sm.track, sm.disc,
            al.name AS album_name, ar.name AS artist_name
       FROM song_masters sm
       JOIN albums al ON al.id = sm.album_id
       JOIN artists ar ON ar.id = sm.artist_id`,
  ).all<LocalSongMatchRow>();
  return result.results;
}

async function loadLocalAlbumMatchRows(db: D1Database): Promise<LocalAlbumMatchRow[]> {
  const result = await db.prepare(
    `SELECT al.id, al.name, al.year,
            (SELECT COUNT(*) FROM song_masters sm0 WHERE sm0.album_id = al.id) AS song_count,
            (SELECT COALESCE(SUM(sm1.duration), 0) FROM song_masters sm1 WHERE sm1.album_id = al.id) AS duration,
            (SELECT ar.name
               FROM song_masters sm
               JOIN artists ar ON ar.id = COALESCE(sm.album_artist_id, sm.artist_id)
              WHERE sm.album_id = al.id
              ORDER BY sm.disc ASC, sm.track ASC
              LIMIT 1) AS artist_name
       FROM albums al`,
  ).all<LocalAlbumMatchRow>();
  return result.results;
}

async function loadLocalArtistMatchRows(db: D1Database): Promise<LocalArtistMatchRow[]> {
  const result = await db.prepare("SELECT id, name FROM artists").all<LocalArtistMatchRow>();
  return result.results;
}

function normalizeCloneSongRef(value: unknown): CloneSongRef {
  if (typeof value === "string") return { id: value };
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    artist: typeof raw.artist === "string" ? raw.artist : undefined,
    album: typeof raw.album === "string" ? raw.album : undefined,
    albumArtist: typeof raw.albumArtist === "string" ? raw.albumArtist : undefined,
    duration: cloneNumber(raw.duration),
    track: cloneNumber(raw.track),
    disc: cloneNumber(raw.disc ?? raw.discNumber),
  };
}

function normalizeCloneItemRef(value: unknown): CloneItemRef | null {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const type = raw.type === "song" || raw.type === "album" || raw.type === "artist" ? raw.type : null;
  if (!id || !type) return null;
  return {
    ...normalizeCloneSongRef(raw),
    id,
    type,
    name: typeof raw.name === "string" ? raw.name : undefined,
    year: cloneNumber(raw.year),
    songCount: cloneNumber(raw.songCount),
    starredAt: cloneNumber(raw.starredAt),
  };
}

function isSoundtrackLikeDuplicate(title: string | null | undefined, album: string | null | undefined): boolean {
  const haystack = `${title || ""} ${album || ""}`.toLowerCase();
  return /soundtrack|bonus\s*track|theme\s*song|trailer|ost|原声|原聲/.test(haystack);
}

async function ensureCloneMapTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS clone_id_map (
       source_key TEXT NOT NULL,
       item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
       remote_id TEXT NOT NULL,
       local_id TEXT NOT NULL,
       created_at INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
       PRIMARY KEY (source_key, item_type, remote_id)
     )`,
  ).run();
}

async function saveCloneIdMap(db: D1Database, sourceKey: string, itemType: "song" | "album" | "artist", remoteId: string, localId: string): Promise<void> {
  if (!remoteId || !localId) return;
  await ensureCloneMapTable(db);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO clone_id_map (source_key, item_type, remote_id, local_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key, item_type, remote_id) DO UPDATE SET
       local_id = excluded.local_id,
       updated_at = excluded.updated_at`,
  ).bind(sourceKey || DEFAULT_CLONE_SOURCE_KEY, itemType, remoteId, localId, now, now).run();
}

async function resolveCloneId(db: D1Database, sourceKey: string, itemType: "song" | "album" | "artist", remoteId: string): Promise<string> {
  if (!remoteId) return remoteId;
  await ensureCloneMapTable(db);
  const row = await db.prepare(
    "SELECT local_id FROM clone_id_map WHERE source_key = ? AND item_type = ? AND remote_id = ?",
  ).bind(sourceKey || DEFAULT_CLONE_SOURCE_KEY, itemType, remoteId).first<{ local_id: string }>();
  return row?.local_id || remoteId;
}

// Bulk variant of resolveCloneId: one clone_id_map query per 80 ids instead of
// one per item. Returns remoteId → localId (unmapped ids map to themselves).
// Keeps upsertStarred/upsertPlaylist within the subrequest budget on large
// lists (176).
async function resolveCloneIds(
  db: D1Database,
  sourceKey: string,
  itemType: "song" | "album" | "artist",
  remoteIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(remoteIds.filter(Boolean))];
  if (ids.length === 0) return out;
  await ensureCloneMapTable(db);
  const key = sourceKey || DEFAULT_CLONE_SOURCE_KEY;
  const BATCH = 80;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT remote_id, local_id FROM clone_id_map WHERE source_key = ? AND item_type = ? AND remote_id IN (${ph})`,
    ).bind(key, itemType, ...batch).all<{ remote_id: string; local_id: string }>();
    for (const r of rows.results) out.set(r.remote_id, r.local_id);
  }
  return out;
}

async function resolveCloneSongRefs(
  db: D1Database,
  sourceKey: string,
  refs: CloneSongRef[],
  rows: LocalSongMatchRow[],
): Promise<{ ids: string[]; unmatched: number }> {
  const legacyIds = refs
    .filter((ref) => !hasSongMetadata(ref))
    .map((ref) => ref.id || "");
  const idMap = await resolveCloneIds(db, sourceKey, "song", legacyIds);
  const localIds = new Set(rows.map((row) => row.id));
  const ids: string[] = [];
  let unmatched = 0;

  for (const ref of refs) {
    let localId = matchSongByName(rows, ref);
    if (!localId && !hasSongMetadata(ref) && ref.id) {
      const mapped = idMap.get(ref.id) || ref.id;
      if (localIds.has(mapped)) localId = mapped;
    }
    if (localId) ids.push(localId);
    else unmatched++;
  }
  return { ids, unmatched };
}

async function resolveCloneItemRefs(
  db: D1Database,
  sourceKey: string,
  items: CloneItemRef[],
  rows: { songs: LocalSongMatchRow[]; albums: LocalAlbumMatchRow[]; artists: LocalArtistMatchRow[] },
): Promise<{ items: Array<{ id: string; type: "song" | "album" | "artist"; starredAt?: number | null }>; unmatched: number }> {
  const legacyIds = {
    song: items.filter((item) => item.type === "song" && !hasSongMetadata(item)).map((item) => item.id),
    album: items.filter((item) => item.type === "album" && !hasAlbumMetadata(item)).map((item) => item.id),
    artist: items.filter((item) => item.type === "artist" && !hasArtistMetadata(item)).map((item) => item.id),
  };
  const maps = {
    song: await resolveCloneIds(db, sourceKey, "song", legacyIds.song),
    album: await resolveCloneIds(db, sourceKey, "album", legacyIds.album),
    artist: await resolveCloneIds(db, sourceKey, "artist", legacyIds.artist),
  };
  const localIds = {
    song: new Set(rows.songs.map((row) => row.id)),
    album: new Set(rows.albums.map((row) => row.id)),
    artist: new Set(rows.artists.map((row) => row.id)),
  };
  const resolved: Array<{ id: string; type: "song" | "album" | "artist"; starredAt?: number | null }> = [];
  let unmatched = 0;

  for (const item of items) {
    let localId: string | null = null;
    if (item.type === "song") localId = matchSongByName(rows.songs, item);
    else if (item.type === "album") localId = matchAlbumByName(rows.albums, item);
    else localId = matchArtistByName(rows.artists, item);

    const hasMetadata = item.type === "song"
      ? hasSongMetadata(item)
      : item.type === "album"
        ? hasAlbumMetadata(item)
        : hasArtistMetadata(item);
    if (!localId && !hasMetadata) {
      const mapped = maps[item.type].get(item.id) || item.id;
      if (localIds[item.type].has(mapped)) localId = mapped;
    }

    if (localId) resolved.push({ id: localId, type: item.type, starredAt: item.starredAt });
    else unmatched++;
  }
  return { items: resolved, unmatched };
}

// Resolve the local target user for a starred/playlist clone and enforce the
// graded permission model (176): writing to your own account needs no extra
// permission; writing to a different user requires manage_users.
async function resolveTargetUser(
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
  requested: string | null | undefined,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const sessionUser = c.var.user.username;
  const target = (requested || "").trim() || sessionUser;
  if (target === sessionUser) return { ok: true, userId: target };
  // An unknown target user falls back to the caller's own account (writing to
  // self needs no extra permission) — this keeps a clone from failing when the
  // upstream owner has no local counterpart, matching the pre-176 fallback.
  const exists = await c.env.DB.prepare("SELECT username FROM users WHERE username = ?")
    .bind(target).first<{ username: string }>();
  if (!exists) return { ok: true, userId: sessionUser };
  // Writing to a DIFFERENT existing user requires manage_users.
  const allowed = await hasPermission(c.env, c.var.user, "manage_users");
  if (!allowed) return { ok: false };
  return { ok: true, userId: target };
}

async function resolveExistingSongMaster(
  db: D1Database,
  song: { id: string; title: string; duration?: number | null },
  album: { name: string },
  artist: { name: string },
): Promise<string> {
  const exact = await db.prepare("SELECT id FROM song_masters WHERE id = ?")
    .bind(song.id).first<{ id: string }>();
  if (exact) return exact.id;

  const titleN = normMatch(song.title);
  const albumN = normMatch(album.name);
  const artistN = normMatch(artist.name);
  if (!titleN || !albumN || !artistN) return song.id;

  const result = await db.prepare(
    `SELECT sm.id, sm.duration, sm.title, al.name AS album_name, ar.name AS artist_name
       FROM song_masters sm
       JOIN albums al ON al.id = sm.album_id
       JOIN artists ar ON ar.id = sm.artist_id
      WHERE lower(sm.title) = ?
        AND lower(al.name) = ?
        AND lower(ar.name) = ?
      LIMIT 10`,
  ).bind(titleN, albumN, artistN).all<{ id: string; duration: number | null; title: string; album_name: string; artist_name: string }>();

  for (const row of result.results) {
    if (normMatch(row.title) !== titleN || normMatch(row.album_name) !== albumN || normMatch(row.artist_name) !== artistN) continue;
    if (song.duration == null || row.duration == null || Math.abs(row.duration - song.duration) <= 3) return row.id;
  }

  const fuzzyRows = await db.prepare(
    `SELECT sm.id, sm.duration, sm.title, al.name AS album_name, ar.name AS artist_name
       FROM song_masters sm
       JOIN albums al ON al.id = sm.album_id
       JOIN artists ar ON ar.id = sm.artist_id
      WHERE (? IS NULL OR sm.duration IS NULL OR ABS(sm.duration - ?) <= 3)
      LIMIT 500`,
  ).bind(song.duration ?? null, song.duration ?? null).all<{ id: string; duration: number | null; title: string; album_name: string; artist_name: string }>();

  const titleF = normFuzzy(song.title);
  const albumF = normFuzzy(album.name);
  const artistF = normFuzzy(artist.name);
  for (const row of fuzzyRows.results) {
    const durationOk = song.duration == null || row.duration == null || Math.abs(row.duration - song.duration) <= 3;
    if (!durationOk) continue;
    const rowTitleF = normFuzzy(row.title);
    const rowAlbumF = normFuzzy(row.album_name);
    const albumOk = fuzzyCompatible(rowAlbumF, albumF);
    const titleOk = fuzzyCompatible(rowTitleF, titleF);
    if (!albumOk || !titleOk) continue;
    if (artistsCompatible(row.artist_name, artist.name)) return row.id;
    if (rowTitleF === titleF && rowAlbumF === albumF && song.duration != null && row.duration != null && Math.abs(row.duration - song.duration) < 2) return row.id;
    if (rowTitleF === titleF && rowAlbumF === albumF && isSoundtrackLikeDuplicate(song.title, album.name)) return row.id;
  }
  return song.id;
}

function signedUpstreamUrl(baseUrl: string, username: string, password: string, path: string, params?: Record<string, string>): string {
  const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
  const q = new URLSearchParams({
    u: username,
    t: md5(password + s),
    s,
    v: "1.16.1",
    c: "EdgeSonicCloneProxy",
    f: "json",
    ...(params || {}),
  });
  return `${baseUrl.replace(/\/+$/, "")}/rest/${path}?${q.toString()}`;
}

// CORS-safe clone proxy. The browser POSTs upstream credentials to the
// EdgeSonic worker; the worker performs the upstream fetch server-side and
// returns the raw response. This avoids browser CORS restrictions when the
// upstream Subsonic server doesn't emit Access-Control-Allow-Origin.
// 176: session-only (any authenticated user). Non-admins need this to read the
// upstream they clone favourites/playlists from. The SSRF surface (server-side
// fetch of a user-supplied URL) is an accepted trade-off for that flow.
cloneRoutes.post("/clone/proxy", async (c) => {
  const body = await c.req.json<{
    upstreamUrl?: string;
    username?: string;
    password?: string;
    path?: string;
    params?: Record<string, string>;
    binary?: boolean;
  }>().catch(() => ({} as {
    upstreamUrl?: string; username?: string; password?: string; path?: string; params?: Record<string, string>; binary?: boolean;
  }));
  if (!body.upstreamUrl || !body.username || !body.password || !body.path) {
    return c.json({ ok: false, error: "Missing upstreamUrl / username / password / path" }, 400);
  }
  const url = signedUpstreamUrl(body.upstreamUrl, body.username, body.password, body.path, body.params);
  const resp = await fetch(url);
  if (body.binary) {
    const ab = await resp.arrayBuffer();
    return new Response(ab, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream",
      },
    });
  }
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json; charset=UTF-8",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertMaster
// ---------------------------------------------------------------------------
// Body: { artist, album, song, albumArtist?, sourceKey? }
//   artist:    { id, name, sortName?, imageUrl? }
//   album:     { id, name, sortName?, year?, genre?, coverUrl? }
//   song:      { id, albumId, artistId, albumArtistId?, title, sortTitle?,
//                track?, disc?, duration?, genre?, compilation?, lyrics? }
//  albumArtist: optional { id, name, sortName? }
//
// Behaviour:
//  * INSERT OR IGNORE artists (artist + optional albumArtist)
//  * INSERT OR IGNORE albums
//  * INSERT OR IGNORE song_masters
//  * If song_masters row already existed, UPDATE the nullable columns with
//   the upstream values (COALESCE keeps existing non-null values when the
//   upstream omits a field). This lets a re-clone backfill fields that
//   were empty on the first pass.
//
// Response: { ok: true, masterId }
cloneRoutes.post("/clone/upsertMaster", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    artist?: { id: string; name: string; sortName?: string | null };
    album?: { id: string; name: string; sortName?: string | null; year?: number | null; genre?: string | null };
    song?: {
      id: string; albumId: string; artistId: string; albumArtistId?: string | null;
      title: string; sortTitle?: string | null;
      track?: number | null; disc?: number | null;
      duration?: number | null; genre?: string | null;
      compilation?: number | null; lyrics?: string | null;
    };
    albumArtist?: { id: string; name: string; sortName?: string | null };
    sourceKey?: string;
  }>();

  const { artist, album, song, albumArtist } = body;
  if (!artist || !album || !song) {
    return c.json({ ok: false, error: "Missing artist/album/song" }, 400);
  }
  if (!artist.id || !artist.name || !album.id || !album.name || !song.id || !song.title) {
    return c.json({ ok: false, error: "Missing required id/name fields" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const sourceKey = body.sourceKey || DEFAULT_CLONE_SOURCE_KEY;
  const localSongId = await resolveExistingSongMaster(db, song, album, artist);
  const stmts: D1PreparedStatement[] = [];
  const artistCredits = parseArtistCredits(artist.name);
  const hasMultipleArtists = artistCredits.length > 1;
  if (!hasMultipleArtists) artistCredits[0].id = artist.id;
  const localArtistId = artistCredits[0].id;
  const localAlbumArtistId = hasMultipleArtists && song.albumArtistId === artist.id
    ? localArtistId
    : song.albumArtistId ?? null;

  stmts.push(...artistInsertStatements(db, artistCredits, now));

  if (albumArtist && albumArtist.id && albumArtist.id !== artist.id) {
    stmts.push(
      db.prepare(
        "INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(albumArtist.id, albumArtist.name, albumArtist.sortName ?? albumArtist.name.toLowerCase(), now, now),
    );
  }

  stmts.push(
    db.prepare(
      "INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(album.id, album.name, album.sortName ?? album.name.toLowerCase(), album.year ?? null, album.genre ?? null, now, now),
  );

  stmts.push(
    db.prepare(
      `INSERT OR IGNORE INTO song_masters
         (id, album_id, artist_id, album_artist_id, title, sort_title,
          track, disc, duration, genre, compilation, lyrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      localSongId,
      song.albumId,
      localArtistId,
      localAlbumArtistId,
      song.title,
      song.sortTitle ?? song.title.toLowerCase(),
      song.track ?? null,
      song.disc ?? null,
      song.duration ?? null,
      song.genre ?? null,
      song.compilation ?? 0,
      song.lyrics ?? null,
      now,
      now,
    ),
  );
  if (hasMultipleArtists) stmts.push(...songArtistStatements(db, localSongId, artistCredits));

  await db.batch(stmts);

  // Backfill album year/genre + song_masters nullable columns when the row
  // pre-existed (INSERT OR IGNORE skipped it). COALESCE preserves any local
  // non-null value so a richer local scan doesn't get clobbered by a thinner
  // upstream response.
  if (album.year !== undefined || album.genre !== undefined) {
    await db.prepare(
      "UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?",
    ).bind(album.year ?? null, album.genre ?? null, now, album.id).run();
  }

  await db.prepare(
    `UPDATE song_masters SET
       artist_id = ?,
       album_artist_id = COALESCE(?, album_artist_id),
       track = COALESCE(?, track),
       disc = COALESCE(?, disc),
       duration = COALESCE(?, duration),
       genre = COALESCE(?, genre),
       compilation = CASE WHEN ? IS NOT NULL THEN ? ELSE compilation END,
       lyrics = COALESCE(?, lyrics),
       updated_at = ?
     WHERE id = ?`,
  ).bind(
    localArtistId,
    localAlbumArtistId,
    song.track ?? null,
    song.disc ?? null,
    song.duration ?? null,
    song.genre ?? null,
    song.compilation ?? null,
    song.compilation ?? null,
    song.lyrics ?? null,
    now,
     localSongId,
  ).run();

  await saveCloneIdMap(db, sourceKey, "song", song.id, localSongId);
  await saveCloneIdMap(db, sourceKey, "album", album.id, album.id);
  await saveCloneIdMap(db, sourceKey, "artist", artist.id, localArtistId);

  return c.json({ ok: true, masterId: localSongId });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertPlaylist
// ---------------------------------------------------------------------------
// Body: { playlist, entries, sourceKey? }
//  playlist: { id, name, owner, public?, comment?, coverUrl? }
//   entries:  string[] — song_master ids in order
//
// Replaces local playlist rows + entries on each call (mirrors the
// replacePlaylistSongs query semantics). INSERT OR REPLACE the playlist
// header so re-cloning refreshes name/public/comment atomically.
// 176: `owner` is the target local user. Writing to your own account needs no
// extra permission; a different owner requires manage_users. `append` lets the
// browser stream a large playlist in bounded chunks — the first call (append
// false) (re)creates the header and clears entries, each subsequent append
// chunk tacks its entries on at the current tail. This keeps a single upstream
// playlist from being cloned in one oversized request (subrequest budget).
async function resolveClonePlaylistId(
  db: D1Database,
  requestedId: string,
  name: string,
  owner: string,
  sourceKey: string,
  append: boolean,
): Promise<string | null> {
  const byName = await db.prepare("SELECT id, name FROM playlists WHERE owner = ?")
    .bind(owner).all<{ id: string; name: string }>();
  const sameName = byName.results.filter((row) => normMatch(row.name) === normMatch(name));
  const byId = await db.prepare("SELECT id, name, owner FROM playlists WHERE id = ?")
    .bind(requestedId).first<{ id: string; name: string; owner: string }>();

  if (append) {
    if (byId?.owner === owner && normMatch(byId.name) === normMatch(name)) return requestedId;
    if (sameName.length === 1) return sameName[0].id;
    return null;
  }

  if (sameName.length === 1) return sameName[0].id;
  if (!byId) return requestedId;
  if (byId.owner === owner && normMatch(byId.name) === normMatch(name)) return requestedId;

  // A remote playlist id colliding with a different local playlist must never
  // overwrite that playlist. The source/name hash keeps repeated clones stable.
  return `pl-clone-${md5(`${sourceKey}\n${owner}\n${normMatch(name)}`).slice(0, 20)}`;
}

cloneRoutes.post("/clone/upsertPlaylist", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    playlist?: {
      id: string; name: string; owner?: string;
      public?: boolean | null; comment?: string | null;
    };
    entries?: Array<string | CloneSongRef>;
    append?: boolean;
    sourceKey?: string;
  }>().catch(() => ({} as { playlist?: { id: string; name: string; owner?: string; public?: boolean | null; comment?: string | null }; entries?: Array<string | CloneSongRef>; append?: boolean; sourceKey?: string }));

  const { playlist, entries } = body;
  if (!playlist || !playlist.id || !playlist.name) {
    return c.json({ ok: false, error: "Missing playlist fields" }, 400);
  }
  const target = await resolveTargetUser(c, playlist.owner);
  if (!target.ok) {
    return c.json({ ok: false, error: "manage_users required to clone into another user" }, 403);
  }
  const owner = target.userId;
  const sourceKey = body.sourceKey || DEFAULT_CLONE_SOURCE_KEY;
  const append = body.append === true;
  const now = Math.floor(Date.now() / 1000);
  const playlistId = await resolveClonePlaylistId(db, playlist.id, playlist.name, owner, sourceKey, append);
  if (!playlistId) {
    return c.json({ ok: false, error: "Cannot uniquely match the target playlist by name" }, 409);
  }

  const refs = Array.isArray(entries) ? entries.map(normalizeCloneSongRef) : [];
  const localSongs = await loadLocalSongMatchRows(db);
  const resolved = await resolveCloneSongRefs(db, sourceKey, refs, localSongs);
  const songIds = resolved.ids;

  if (!append) {
    await db.batch([
      db.prepare(
        `INSERT OR REPLACE INTO playlists
           (id, name, owner, public, song_count, duration, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      ).bind(playlistId, playlist.name, owner, playlist.public ? 1 : 0, playlist.comment ?? null, now, now),
      db.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").bind(playlistId),
    ]);
  } else {
    const exists = await db.prepare("SELECT id FROM playlists WHERE id = ? AND owner = ?")
      .bind(playlistId, owner).first<{ id: string }>();
    if (!exists) {
      return c.json({ ok: false, error: "append to a playlist that was never created (send the first chunk without append)" }, 400);
    }
  }

  // Position base = current tail (0 on the replace path since we just cleared).
  let base = 0;
  if (append) {
    const cnt = await db.prepare("SELECT COUNT(*) AS c FROM playlist_songs WHERE playlist_id = ?")
      .bind(playlistId).first<{ c: number }>();
    base = cnt?.c ?? 0;
  }

  if (songIds.length > 0) {
    const insertStmts: D1PreparedStatement[] = [];
    let pos = base;
    for (const sid of songIds) {
      insertStmts.push(
        db.prepare("INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)")
          .bind(playlistId, sid, pos, now),
      );
      pos++;
    }
    if (insertStmts.length > 0) await db.batch(insertStmts);
  }

  // Resync header count + duration from the actual rows (covers replace + append).
  const totals = await db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(sm.duration), 0) AS d
       FROM playlist_songs ps JOIN song_masters sm ON sm.id = ps.song_master_id
      WHERE ps.playlist_id = ?`,
  ).bind(playlistId).first<{ c: number; d: number }>();
  await db.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
    .bind(totals?.c ?? 0, totals?.d ?? 0, now, playlistId).run();

  return c.json({ ok: true, playlistId, inserted: songIds.length, unmatched: resolved.unmatched, owner, append });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertStarred
// ---------------------------------------------------------------------------
// Body: { userId, items, sourceKey? }
//  userId: local users.username to attribute the stars to
//  items: Array<{ id, type: 'song'|'album'|'artist', starredAt? }>
//
// Uses starItem() semantics: UPSERT annotations, set starred=1 + starred_at.
// We don't unstar items that are absent from the upstream list — a clone is
// additive by design so local-only stars survive.
// 176: `userId` is optional; omitted (or equal to the session user) → the stars
// land on the caller's own account (no extra permission). A different target
// requires manage_users. Ids are resolved in bulk and inserted with one
// db.batch so a chunk is a bounded number of subrequests; the browser sends
// items in bounded chunks (cloneStarredStage) so a huge list never overflows.
cloneRoutes.post("/clone/upsertStarred", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    userId?: string;
    items?: Array<CloneItemRef>;
    sourceKey?: string;
  }>().catch(() => ({} as { userId?: string; items?: Array<CloneItemRef>; sourceKey?: string }));

  const target = await resolveTargetUser(c, body.userId);
  if (!target.ok) {
    return c.json({ ok: false, error: "manage_users required to clone into another user" }, 403);
  }
  const userId = target.userId;
  const items = Array.isArray(body.items)
    ? body.items.map(normalizeCloneItemRef).filter((item): item is CloneItemRef => item !== null)
    : [];
  const sourceKey = body.sourceKey || DEFAULT_CLONE_SOURCE_KEY;

  const resolved = await resolveCloneItemRefs(db, sourceKey, items, {
    songs: await loadLocalSongMatchRows(db),
    albums: await loadLocalAlbumMatchRows(db),
    artists: await loadLocalArtistMatchRows(db),
  });

  const nowDefault = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = resolved.items.map((it) => {
    const starredAt = it.starredAt ?? nowDefault;
    return db.prepare(
      `INSERT INTO annotations (user_id, item_id, item_type, play_count, starred, starred_at)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
         starred = 1,
         starred_at = excluded.starred_at`,
    ).bind(userId, it.id, it.type, starredAt);
  });
  if (stmts.length > 0) await db.batch(stmts);

  return c.json({ ok: true, applied: stmts.length, unmatched: resolved.unmatched, userId });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertUser
// ---------------------------------------------------------------------------
// Body: { user, credentials? }
//   user:      { username, masterPassword (already SHA-256 hashed upstream? no — plaintext),
//                level?, enabled? }
//  credentials: Array<{ password, label?, streamProxyStrategy? }> — Subsonic client
//                passwords to mirror into local subsonic_credentials.
//
// EdgeSonic stores master_password as SHA-256(password). The upstream
// getStarred/getUsers responses expose the password as plaintext (Subsonic
// spec requires it for token auth), so we hash here before INSERT. If the
// caller already hashed, set `passwordHashed: true` to skip hashing.
// 176: super admin only — the clone-all-users flow provisions local accounts
// (and their login passwords), a strictly higher-privilege operation than the
// per-account favourite/playlist clone.
cloneRoutes.post("/clone/upsertUser", permissionMiddleware("manage_users"), async (c) => {
  if (c.var.user.level !== 3) {
    return c.json({ ok: false, error: "Super admin required" }, 403);
  }
  const db = c.env.DB;
  const body = await c.req.json<{
    user?: {
      username: string;
      password: string;        // plaintext (or pre-hashed if passwordHashed=true)
      passwordHashed?: boolean;
      level?: number;
      enabled?: boolean | number;
    };
    credentials?: Array<{
      password: string;
      label?: string | null;
      streamProxyStrategy?: string | null;
    }>;
  }>();

  const { user, credentials } = body;
  if (!user || !user.username || !user.password) {
    return c.json({ ok: false, error: "Missing user fields" }, 400);
  }

  const level = typeof user.level === "number" ? Math.max(0, Math.min(3, user.level)) : 1;
  if ((level === 0) !== (user.username === GUEST_USERNAME)) {
    return c.json({ ok: false, error: "Level 0 is reserved for the guest account" }, 400);
  }
  const enabledNum = typeof user.enabled === "number"
    ? (user.enabled ? 1 : 0)
    : (user.enabled === false ? 0 : 1);
  const masterPassword = user.passwordHashed
    ? user.password
    : await sha256(user.password);
  const now = Math.floor(Date.now() / 1000);

  await db.prepare(
    `INSERT OR REPLACE INTO users
       (username, master_password, level, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(user.username, masterPassword, level, enabledNum, now, now).run();

  let credsApplied = 0;
  if (Array.isArray(credentials)) {
    for (const cred of credentials) {
      if (!cred.password) continue;
      const strategy = cred.streamProxyStrategy || "always";
      if (!["always", "never", "r2_only", "webdav_only"].includes(strategy)) continue;
      const id = crypto.randomUUID().substring(0, 12);
      await db.prepare(
        "INSERT INTO subsonic_credentials (id, username, password, label, stream_proxy_strategy, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, user.username, cred.password, cred.label || "", strategy, now).run();
      credsApplied++;
    }
  }

  return c.json({ ok: true, username: user.username, credentialsApplied: credsApplied });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/ingestAudio
// ---------------------------------------------------------------------------
// Body: raw bytes (the upstream /rest/stream payload).
// Query: ?masterId=<song_master_id>&suffix=<ext>&contentType=<mime>&
//      &artist=<...>&album=<...>&filename=<...>&size=<bytes>&originalPath=<...>
//
// Writes R2 key from upstream originalPath when available, otherwise falls
// back to `music/{artist}/{album}/{stem}.{masterIdHash}.{ext}` (see
// fallbackR2Key for why the hash is needed), and creates a
// song_instances row (source_type='original', source_id='r2-local',
// storage_uri=r2://music/...). Idempotent: if a song_instance with the
// same storage_uri already exists, the R2 put still happens (overwrite)
// but the D1 insert is skipped.
//
// Mirrors work_upload.ts shape (binary body, R2 put, song_instances
// register) but the caller is the browser, not a browser-pool worker, so
// there's no HMAC token — the session middleware + manage_users guard is
// the auth surface.
const MAX_INGEST_BYTES = 256 * 1024 * 1024;

// Shared by ingestAudio (bytes come from the browser's POST body, already
// fully buffered by the time Hono hands it to us) and fetchAudioToR2 (bytes
// come from a server-side fetch of the upstream /rest/stream — streamed
// straight through to R2 rather than buffered, see 159) — both just need
// "verify master exists, R2 put, idempotent song_instances insert".
async function registerAudioInstance(
  env: Env,
  db: D1Database,
  params: {
    masterId: string; suffix: string; contentType: string; sourceKey?: string;
    artistDir: string; albumDir: string; filename: string; originalPath?: string;
    declaredSize: number; body: ArrayBuffer | ReadableStream<Uint8Array>;
  },
): Promise<
  | { ok: true; r2Key: string; size: number; instanceId?: string; registered: boolean }
  | { ok: false; error: string; status: 400 | 404 | 413 }
> {
  const { suffix, contentType, artistDir, albumDir, filename, originalPath, declaredSize, body } = params;
  const masterId = await resolveCloneId(db, params.sourceKey || DEFAULT_CLONE_SOURCE_KEY, "song", params.masterId);

  const isBuffer = body instanceof ArrayBuffer;
  if (isBuffer) {
    if (body.byteLength === 0) return { ok: false, error: "Empty body", status: 400 };
    if (body.byteLength > MAX_INGEST_BYTES) return { ok: false, error: "Payload too large", status: 413 };
  }
  // Streamed bodies can't be length-checked up front — fetchAudioToR2 checks
  // the upstream Content-Length header before ever calling in here, and the
  // post-put size==0 check below catches a genuinely empty stream.

  // Verify the master exists so we don't write orphan bytes to R2.
  const master = await db.prepare("SELECT id FROM song_masters WHERE id = ?")
    .bind(masterId).first<{ id: string }>();
  if (!master) {
    return { ok: false, error: "song_master not found — upsertMaster first", status: 404 };
  }

  const r2Key = originalPathToR2Key(originalPath) || fallbackR2Key(artistDir, albumDir, filename, masterId);
  const r2Object = await env.MUSIC_BUCKET.put(r2Key, body, {
    httpMetadata: { contentType },
  });
  const size = r2Object?.size ?? (isBuffer ? body.byteLength : declaredSize);
  if (size === 0) {
    await env.MUSIC_BUCKET.delete(r2Key);
    return { ok: false, error: "Empty body", status: 400 };
  }
  const storageUri = `r2://${r2Key}`;

  // Idempotent instance row: skip if one already points at this uri.
  const existing = await db.prepare(
    "SELECT id FROM song_instances WHERE storage_uri = ? AND master_id = ?",
  ).bind(storageUri, masterId).first<{ id: string }>();
  if (existing) {
    return { ok: true, r2Key, size, instanceId: existing.id, registered: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const instanceId = `si-clone-${rand}`;
  try {
    await db.prepare(
      `INSERT INTO song_instances
         (id, master_id, source_id, source_type, storage_uri, suffix, content_type,
          size, tag_scanned, created_at, updated_at)
       VALUES (?, ?, 'r2-local', 'original', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      instanceId,
      masterId,
      storageUri,
      suffix || extToSuffix(filename),
      contentType,
      declaredSize || size,
      now,
      now,
    ).run();
  } catch (e) {
    // FK / PK failure shouldn't fail the whole clone — R2 bytes are valid.
    console.error(`[clone] instance registration failed:`, e);
    return { ok: true, r2Key, size, registered: false };
  }

  return { ok: true, r2Key, size, instanceId, registered: true };
}

cloneRoutes.post("/clone/ingestAudio", permissionMiddleware("manage_users"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const masterId = c.req.query("masterId") || "";
  const sourceKey = c.req.query("sourceKey") || DEFAULT_CLONE_SOURCE_KEY;
  const suffix = (c.req.query("suffix") || "").toLowerCase();
  const contentType = c.req.query("contentType") || "application/octet-stream";
  const artistDir = (c.req.query("artist") || "Unknown Artist").replace(/[\/]+/g, "_").trim() || "Unknown Artist";
  const albumDir = (c.req.query("album") || "Unknown Album").replace(/[\/]+/g, "_").trim() || "Unknown Album";
  const filename = (c.req.query("filename") || "").replace(/[\/]+/g, "_").trim();
  const originalPath = c.req.query("originalPath") || "";
  const declaredSize = parseInt(c.req.query("size") || "0", 10);

  if (!masterId || !filename) {
    return c.json({ ok: false, error: "Missing masterId or filename" }, 400);
  }

  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10);
  if (contentLength && contentLength > MAX_INGEST_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }
  const buf = await c.req.arrayBuffer();

  const result = await registerAudioInstance(env, db, {
    masterId, suffix, contentType, sourceKey, artistDir, albumDir, filename, originalPath, declaredSize, body: buf,
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/fetchAudioToR2
// ---------------------------------------------------------------------------
// Server-side counterpart to ingestAudio: the Worker itself fetches the
// upstream /rest/stream bytes and writes them straight to R2, so the
// browser never downloads-then-reuploads the audio — this is the
// "省流量" (bandwidth-saving) clone-audio mode selectable in Tools.vue.
// Trade-off: the fetch now runs on the Worker's own outbound connection
// (subject to CF subrequest/CPU limits and no per-file retry UI), which is
// why the browser download+reupload path stays available as the "stable"
// fallback for flaky/slow upstreams.
//
// Body: { upstreamUrl, username, password, songId, masterId, suffix,
//         contentType, artist, album, filename, originalPath, size }
cloneRoutes.post("/clone/fetchAudioToR2", permissionMiddleware("manage_users"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const body = await c.req.json<{
    upstreamUrl?: string; username?: string; password?: string; songId?: string;
    masterId?: string; sourceKey?: string; suffix?: string; contentType?: string;
    artist?: string; album?: string; filename?: string; originalPath?: string; size?: number;
  }>().catch(() => ({} as Record<string, never>));

  const { upstreamUrl, username, password, songId, masterId, filename } = body;
  if (!upstreamUrl || !username || !password || !songId || !masterId || !filename) {
    return c.json({ ok: false, error: "Missing upstreamUrl / username / password / songId / masterId / filename" }, 400);
  }

  const artistDir = (body.artist || "Unknown Artist").replace(/[\/]+/g, "_").trim() || "Unknown Artist";
  const albumDir = (body.album || "Unknown Album").replace(/[\/]+/g, "_").trim() || "Unknown Album";
  const cleanFilename = filename.replace(/[\/]+/g, "_").trim();
  const suffix = (body.suffix || extToSuffix(cleanFilename)).toLowerCase();
  const contentType = body.contentType || "application/octet-stream";

  const url = signedUpstreamUrl(upstreamUrl, username, password, "stream", { id: songId });
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (e) {
    return c.json({ ok: false, error: `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
  if (!resp.ok) {
    return c.json({ ok: false, error: `upstream stream returned HTTP ${resp.status}` }, 502);
  }
  // 159: was `await resp.arrayBuffer()` — buffering the whole file into
  // Worker memory before handing it to R2. Lossless files easily run
  // 30-80MB+; a few of those in flight at once (CLONE_AUDIO_CONCURRENCY=3
  // in Tools.vue) was blowing past the isolate's memory budget, surfacing
  // to the browser as an opaque "Worker exceeded resource limits" 503.
  // Stream resp.body straight into R2.put() instead — this is R2's
  // documented pattern for proxying a fetch response without buffering.
  if (!resp.body) {
    return c.json({ ok: false, error: "upstream stream had no body" }, 502);
  }
  const upstreamLength = parseInt(resp.headers.get("Content-Length") || "0", 10);
  if (upstreamLength && upstreamLength > MAX_INGEST_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }

  const result = await registerAudioInstance(env, db, {
    masterId, sourceKey: body.sourceKey || DEFAULT_CLONE_SOURCE_KEY, suffix, contentType, artistDir, albumDir, filename: cleanFilename, originalPath: body.originalPath,
    declaredSize: body.size || upstreamLength || 0, body: resp.body,
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
  return c.json(result);
});

function extToSuffix(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.substring(idx + 1).toLowerCase() : "";
}

// Fallback keys are synthesized from artist/album/title, which two distinct
// songs can legitimately share (same title across discs, remaster vs
// original, ...). A bare `music/{artist}/{album}/{filename}` would then let
// the second R2 put silently overwrite the first upload's bytes while both
// song_instances keep pointing at the single surviving object. Inject a
// short stable hash of the *local* master id before the extension: distinct
// masters can never collide, while a re-run of the same master (resume,
// re-clone after wiping R2) still lands on the same key so the idempotent
// instance check keeps working. Keys derived from originalPath are exempt —
// the upstream path itself is the uniqueness source there.
export function fallbackR2Key(artistDir: string, albumDir: string, filename: string, masterId: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.substring(0, dot) : filename;
  const ext = dot > 0 ? filename.substring(dot) : "";
  return `music/${artistDir}/${albumDir}/${stem}.${fnv1aHex8(masterId)}${ext}`;
}

// Tiny non-cryptographic FNV-1a (32-bit, hex) — collision-resistant enough
// to disambiguate same-titled siblings within one album directory.
function fnv1aHex8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// R2 keys max out at 1024 bytes (UTF-8). Reject well before that so a
// pathological upstream path falls back to the synthesized key instead of
// failing the R2 put mid-clone.
const MAX_R2_KEY_BYTES = 900;

export function originalPathToR2Key(path: string | null | undefined): string | null {
  let clean = (path || "").replace(/\\+/g, "/").replace(/^\s+|\s+$/g, "");
  if (!clean) return null;
  clean = clean.replace(/^[A-Za-z]:\/+/, "").replace(/^\/+/, "");
  const parts = clean.split("/").filter((part) => part && part !== "." && part !== "..");
  if (!parts.length) return null;
  const musicIdx = parts.findIndex((part) => part.toLowerCase() === "music");
  const relative = musicIdx >= 0 ? parts.slice(musicIdx) : ["music", ...parts];
  const safe = relative.map((part) => part.replace(/[\u0000-\u001f\u007f]/g, "").trim()).filter(Boolean);
  if (safe.length < 2) return null;
  // Canonicalize the root segment: the case-insensitive match above accepts
  // "Music"/"MUSIC" but every other subsystem (scan, file browser) treats the
  // lowercase music/ prefix as the library root — keep the key under it.
  safe[0] = "music";
  const key = safe.join("/");
  if (new TextEncoder().encode(key).byteLength > MAX_R2_KEY_BYTES) return null;
  return key;
}
