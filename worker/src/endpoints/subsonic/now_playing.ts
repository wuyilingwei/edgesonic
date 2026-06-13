// ============================================================================
// Task 047 — getNowPlaying (KV-backed active stream registry).
//
// Companion to the scrobble KV write in annotation.ts: every scrobble (both
// submission=true and =false) writes `now_playing:{username}` → {songId,
// startedAt, clientId} with a 300s TTL. This endpoint scans that key prefix
// and returns one <entry> per active listener with full song metadata + a
// `minutesAgo` field and `playerId`.
//
// Visibility:
//   admin (level=3) → all active listeners
//   non-admin       → only own row
// (EdgeSonic has no "public user" flag yet — when 044 / sharing lands, this
// is the place to OR in `users.public = 1`.)
//
// Permission: `browse` (consistent with getRandomSongs / search3).
// ============================================================================

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { permissionMiddleware } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { mapSong } from "../../types/subsonic";
import type { User, SongMaster } from "../../types/entities";

export const nowPlayingRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// Shape of the JSON value stored at `now_playing:{username}`.
interface NowPlayingEntry {
  songId: string;
  startedAt: number; // unix seconds
  clientId: string;
}

const PREFIX = "now_playing:";

const getNowPlayingHandler = async (c: import("hono").Context<{
  Bindings: Env;
  Variables: { user: User };
}>) => {
  const user = c.get("user");
  const env = c.env;

  // Scan all active now_playing entries. KV.list returns key names; we then
  // fetch each value in parallel. We cap the result set at 1000 keys — a
  // reasonable upper bound for "concurrent listeners on one instance" and
  // matches KV.list's default per-page limit.
  const listed = await env.KV.list({ prefix: PREFIX, limit: 1000 });

  // Visibility filter (before fetching values — saves KV reads).
  const isAdmin = user.level === 3;
  const visibleKeys = isAdmin
    ? listed.keys.map((k) => k.name)
    : listed.keys
        .map((k) => k.name)
        .filter((name) => name === `${PREFIX}${user.username}`);

  if (visibleKeys.length === 0) {
    return c.text(subsonicOK({ nowPlaying: {} }), 200, XML);
  }

  // Fetch values in parallel.
  const fetched = await Promise.all(
    visibleKeys.map(async (key) => {
      const raw = await env.KV.get(key);
      if (!raw) return null;
      let parsed: NowPlayingEntry | null = null;
      try {
        parsed = JSON.parse(raw) as NowPlayingEntry;
      } catch {
        return null;
      }
      if (!parsed?.songId) return null;
      const username = key.slice(PREFIX.length);
      return { username, ...parsed };
    }),
  );
  const entries = fetched.filter((x): x is NowPlayingEntry & { username: string } => x !== null);

  if (entries.length === 0) {
    return c.text(subsonicOK({ nowPlaying: {} }), 200, XML);
  }

  // Hydrate song metadata in a single IN(...) query.
  const songIds = entries.map((e) => e.songId);
  const queries = createQueries(env.DB);
  const songs = await queries.getSongMastersByIds(songIds);
  // We also need artist/album names; join in a tiny secondary lookup.
  const songsWithNames = await Promise.all(
    songs.map(async (s) => {
      const ar = await env.DB.prepare(
        "SELECT name FROM artists WHERE id = ?"
      ).bind(s.artist_id).first<{ name: string }>();
      const al = await env.DB.prepare(
        "SELECT name FROM albums WHERE id = ?"
      ).bind(s.album_id).first<{ name: string }>();
      return Object.assign(s, {
        artist_name: ar?.name ?? null,
        album_name: al?.name ?? null,
      });
    }),
  );
  const songById = new Map<string, SongMaster & { artist_name: string | null; album_name: string | null }>();
  for (const s of songsWithNames) songById.set(s.id, s);

  const nowSec = Math.floor(Date.now() / 1000);
  const entryXmls = entries
    .map((e) => {
      const song = songById.get(e.songId);
      // If the song was deleted between scrobble and getNowPlaying, drop the
      // entry — clients can't play a foreign id anyway.
      if (!song) return null;
      const minutesAgo = Math.max(0, Math.floor((nowSec - e.startedAt) / 60));
      // mapSong returns the standard Subsonic <child> attributes. We extend
      // with username, minutesAgo, playerId, plus the joined artist/album
      // names (mirrors what getStarred / getRandomSongs do).
      return attrs({
        ...mapSong(song, song.album_id),
        artist: song.artist_name ?? undefined,
        album: song.album_name ?? undefined,
        username: e.username,
        minutesAgo,
        playerId: e.clientId,
      });
    })
    .filter((x) => x !== null);

  return c.text(
    subsonicOK({ nowPlaying: { entry: entryXmls } }),
    200, XML,
  );
};

nowPlayingRoutes.get("/getNowPlaying",
  permissionMiddleware("browse"), getNowPlayingHandler);
nowPlayingRoutes.get("/getNowPlaying.view",
  permissionMiddleware("browse"), getNowPlayingHandler);
nowPlayingRoutes.post("/getNowPlaying",
  permissionMiddleware("browse"), getNowPlayingHandler);
nowPlayingRoutes.post("/getNowPlaying.view",
  permissionMiddleware("browse"), getNowPlayingHandler);
