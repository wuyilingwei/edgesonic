// ============================================================================
// Task 047 — getNowPlaying (D1-backed active stream registry).
//
// 090 — Migrated from KV to D1 `now_playing` table. Scrobble writes
// (annotation.ts) UPSERT into now_playing; this endpoint reads with a 300s
// staleness filter (WHERE updated_at > now-300) to match the old KV TTL.
//
// Visibility:
//   view_all_users_items perm → all active listeners
//   otherwise                 → only own row
//
// Permission: `browse` (consistent with getRandomSongs / search3).
// ============================================================================

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { permissionMiddleware } from "../../auth";
import { hasPermission } from "../../utils/permissions";
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

// Row shape from D1 `now_playing` table.
interface NowPlayingEntry {
  songId: string;
  startedAt: number; // unix seconds
  clientId: string;
}

// Active-stream TTL: matches the old KV expirationTtl (300s).
const NOW_PLAYING_TTL_SEC = 300;

const getNowPlayingHandler = async (c: import("hono").Context<{
  Bindings: Env;
  Variables: { user: User };
}>) => {
  const user = c.get("user");
  const env = c.env;

  // 090 — Query D1 `now_playing` table; filter rows older than 300s (mirrors
  // old KV TTL). Visibility: view_all_users_items → all rows, else own only.
  const seeAll = await hasPermission(env.DB, user, "view_all_users_items");
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - NOW_PLAYING_TTL_SEC;

  interface NowPlayingRow {
    username: string;
    song_id: string;
    started_at: number;
    client_id: string;
  }

  const rows = seeAll
    ? (await env.DB.prepare(
        "SELECT username, song_id, started_at, client_id FROM now_playing WHERE updated_at > ?"
      ).bind(cutoff).all<NowPlayingRow>()).results
    : (await env.DB.prepare(
        "SELECT username, song_id, started_at, client_id FROM now_playing WHERE username = ? AND updated_at > ?"
      ).bind(user.username, cutoff).all<NowPlayingRow>()).results;

  const entries = rows.map((r) => ({
    username: r.username,
    songId: r.song_id,
    startedAt: r.started_at,
    clientId: r.client_id,
  })).filter((x): x is NowPlayingEntry & { username: string } => Boolean(x.songId));

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
