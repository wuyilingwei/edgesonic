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

// Subsonic Annotation endpoints (task 033).
//
// Routes:
//   - star / unstar        (id|albumId|artistId, repeatable)
//   - setRating            (id, rating 0-5; 0 clears)
//   - scrobble             (id repeatable, time ms?, submission bool default true)
//  - getStarred / getStarred2 (musicFolderId optional, ignored)
//   - getRandomSongs       (size, genre, fromYear, toYear, musicFolderId)
//
// Each route is also exposed at /rest/<name>.view so native Subsonic clients
// that append `.view` (Symfonium, DSub, Navidrome web, etc.) also hit it.
//
// star/unstar/setRating/scrobble require `edit_annotations` permission;
// getStarred / getRandomSongs require `browse`.
//
// Field back-fill (starred / userRating / playCount on artist/album/song
// responses) is NOT done here — that belongs to task 035 (OpenSubsonic
// declaration + browsing field enrichment).

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { mapArtist, mapAlbum, mapSong, type AnnotationLite } from "../../types/subsonic";
import type { User, Annotation } from "../../types/entities";

function liteOf(row: Annotation | undefined): AnnotationLite | undefined {
  if (!row) return undefined;
  return {
    starred: row.starred,
    starred_at: row.starred_at,
    rating: row.rating,
    play_count: row.play_count,
  };
}

export const annotationRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// Subsonic supports passing the same key multiple times (?id=a&id=b). Hono's
// req.queries() returns string[]; some adapters might only fill req.query().
function multi(c: import("hono").Context, key: string): string[] {
  const arr = c.req.queries(key);
  if (arr && arr.length) return arr.filter((x) => x.length > 0);
  const single = c.req.query(key);
  return single ? [single] : [];
}

// Subsonic "true"/"false" → boolean (default when missing).
function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return fallback;
}

function parseIntQ(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// =============================================================================
// star / unstar
// =============================================================================
const starHandler = (mode: "star" | "unstar") => async (c: import("hono").Context) => {
  const ids = multi(c, "id");
  const albumIds = multi(c, "albumId");
  const artistIds = multi(c, "artistId");

  if (ids.length === 0 && albumIds.length === 0 && artistIds.length === 0) {
    return c.text(
      subsonicError(10, "Required parameter is missing (id / albumId / artistId)"),
      400, XML,
    );
  }

  const user = c.get("user") as User;
  const queries = createQueries((c.env as Env).DB);
  const fn = mode === "star" ? queries.starItem : queries.unstarItem;

  for (const id of ids) await fn(user.username, id, "song");
  for (const id of albumIds) await fn(user.username, id, "album");
  for (const id of artistIds) await fn(user.username, id, "artist");

  return c.text(subsonicOK({}), 200, XML);
};

annotationRoutes.get("/star",
  permissionMiddleware("edit_annotations"), starHandler("star"));
annotationRoutes.get("/star.view",
  permissionMiddleware("edit_annotations"), starHandler("star"));
annotationRoutes.post("/star",
  permissionMiddleware("edit_annotations"), starHandler("star"));
annotationRoutes.post("/star.view",
  permissionMiddleware("edit_annotations"), starHandler("star"));

annotationRoutes.get("/unstar",
  permissionMiddleware("edit_annotations"), starHandler("unstar"));
annotationRoutes.get("/unstar.view",
  permissionMiddleware("edit_annotations"), starHandler("unstar"));
annotationRoutes.post("/unstar",
  permissionMiddleware("edit_annotations"), starHandler("unstar"));
annotationRoutes.post("/unstar.view",
  permissionMiddleware("edit_annotations"), starHandler("unstar"));

// =============================================================================
// setRating
// =============================================================================
const setRatingHandler = async (c: import("hono").Context) => {
  const id = c.req.query("id");
  const ratingStr = c.req.query("rating");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing (id)"), 400, XML);
  if (ratingStr === undefined)
    return c.text(subsonicError(10, "Required parameter is missing (rating)"), 400, XML);

  const rating = parseInt(ratingStr, 10);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return c.text(subsonicError(10, "Invalid rating (0-5)"), 400, XML);
  }

  const user = c.get("user") as User;
  const queries = createQueries((c.env as Env).DB);

  // Subsonic spec says setRating's id can be a song, album, or artist.
  // We probe in cheapest order; if none match, persist as 'song' anyway so
  // foreign clients don't silently drop the rating.
  let itemType: "song" | "album" | "artist" = "song";
  if (await queries.getAlbum(id)) itemType = "album";
  else if (await queries.getArtist(id)) itemType = "artist";

  await queries.setItemRating(user.username, id, itemType, rating);
  return c.text(subsonicOK({}), 200, XML);
};

annotationRoutes.get("/setRating",
  permissionMiddleware("edit_annotations"), setRatingHandler);
annotationRoutes.get("/setRating.view",
  permissionMiddleware("edit_annotations"), setRatingHandler);
annotationRoutes.post("/setRating",
  permissionMiddleware("edit_annotations"), setRatingHandler);
annotationRoutes.post("/setRating.view",
  permissionMiddleware("edit_annotations"), setRatingHandler);

// =============================================================================
// scrobble
// =============================================================================
const scrobbleHandler = async (c: import("hono").Context) => {
  const ids = multi(c, "id");
  if (ids.length === 0) {
    return c.text(subsonicError(10, "Required parameter is missing (id)"), 400, XML);
  }

  // Subsonic spec:
  //  submission=true (default) → song actually played to completion: D1 count++
  //   submission=false         → "now playing" heartbeat
  // 047: BOTH update KV `now_playing:{username}` so getNowPlaying can surface
  // the active stream. submission=false only writes KV; submission=true writes
  // KV *and* the D1 annotations row.
  const submission = parseBool(c.req.query("submission"), true);

  // time is milliseconds (Subsonic spec). Default to now.
  const times = c.req.queries("time") ?? [];
  // `c` is the standard Subsonic "client name" parameter (e.g. "DSub").
  const clientId = c.req.query("c") || "";
  const user = c.get("user") as User;
  const env = c.env as Env;
  const queries = createQueries(env.DB);
  const nowSec = Math.floor(Date.now() / 1000);

  // The *last* id in the request is the currently-playing track. The
  // Subsonic protocol allows batched scrobbles but the now-playing notion is
  // singular per user → take the last entry as the "now" track.
  const nowSongId = ids[ids.length - 1];
  try {
    await env.DB.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at)" +
      " VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(username) DO UPDATE SET" +
      "   song_id = excluded.song_id," +
      "   started_at = excluded.started_at," +
      "   client_id = excluded.client_id," +
      "   updated_at = excluded.updated_at"
    ).bind(user.username, nowSongId, nowSec, clientId, nowSec).run();
  } catch {
    // D1 write is best-effort: a failure must not block the scrobble ack.
  }

  if (submission) {
    for (let i = 0; i < ids.length; i++) {
      const ms = times[i] ? parseInt(times[i], 10) : NaN;
      const playDateSec = Number.isFinite(ms) ? Math.floor(ms / 1000) : nowSec;
      await queries.scrobbleSong(user.username, ids[i], playDateSec);
    }
  }
  return c.text(subsonicOK({}), 200, XML);
};

annotationRoutes.get("/scrobble",
  permissionMiddleware("edit_annotations"), scrobbleHandler);
annotationRoutes.get("/scrobble.view",
  permissionMiddleware("edit_annotations"), scrobbleHandler);
annotationRoutes.post("/scrobble",
  permissionMiddleware("edit_annotations"), scrobbleHandler);
annotationRoutes.post("/scrobble.view",
  permissionMiddleware("edit_annotations"), scrobbleHandler);

// =============================================================================
// getStarred / getStarred2
// =============================================================================
// EdgeSonic does not separate ID3 vs directory organisation — both endpoints
// return the same payload, only the wrapper element name differs.
const getStarredHandler = (tag: "starred" | "starred2") =>
  async (c: import("hono").Context) => {
    const user = c.get("user") as User;
    const queries = createQueries((c.env as Env).DB);
    const [artists, albums, songs] = await Promise.all([
      queries.getStarredArtists(user.username),
      queries.getStarredAlbums(user.username),
      queries.getStarredSongs(user.username),
    ]);

    const [artistAnn, albumAnn, songAnn] = await Promise.all([
      queries.getAnnotationsMap(user.username, "artist", artists.map((a) => a.id)),
      queries.getAnnotationsMap(user.username, "album", albums.map((a) => a.id)),
      queries.getAnnotationsMap(user.username, "song", songs.map((s) => s.id)),
    ]);

    return c.text(
      subsonicOK({
        [tag]: {
          artist: artists.map((a) =>
            attrs(mapArtist(a, liteOf(artistAnn.get(`artist:${a.id}`))))
          ),
          album: albums.map((a) =>
            attrs({
              ...mapAlbum(a, a.artist_name ?? undefined, liteOf(albumAnn.get(`album:${a.id}`))),
              artistId: a.artist_id ?? undefined,
            }),
          ),
          song: songs.map((s) =>
            attrs({
              ...mapSong(s, s.album_id, liteOf(songAnn.get(`song:${s.id}`))),
              artist: s.artist_name ?? undefined,
              album: s.album_name ?? undefined,
            }),
          ),
        },
      }),
      200, XML,
    );
  };

function register(path: string, mw: ReturnType<typeof permissionMiddleware>, handler: (c: import("hono").Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    annotationRoutes.get(p, mw, handler);
    annotationRoutes.post(p, mw, handler);
  }
}

register("getStarred", permissionMiddleware("browse"), getStarredHandler("starred"));
register("getStarred2", permissionMiddleware("browse"), getStarredHandler("starred2"));

// =============================================================================
// getRandomSongs
// =============================================================================
const getRandomSongsHandler = async (c: import("hono").Context) => {
  // 157: was capped at 500 for no documented reason — dropped, keeping only
  // the floor of 1 (reject zero/negative).
  const size = Math.max(parseIntQ(c.req.query("size")) ?? 10, 1);
  const genre = c.req.query("genre") || undefined;
  const fromYear = parseIntQ(c.req.query("fromYear"));
  const toYear = parseIntQ(c.req.query("toYear"));
  // musicFolderId intentionally ignored: EdgeSonic exposes a single folder
  // (see getMusicFolders); 038 will revisit when multi-folder support lands.

  const queries = createQueries((c.env as Env).DB);
  const songs = await queries.getRandomSongs({ size, genre, fromYear, toYear });
  const user = c.get("user") as User;
  const songAnn = await queries.getAnnotationsMap(user.username, "song", songs.map((s) => s.id));

  return c.text(
    subsonicOK({
      randomSongs: {
        song: songs.map((s) =>
          attrs({
            ...mapSong(s, s.album_id, liteOf(songAnn.get(`song:${s.id}`))),
            artist: s.artist_name ?? undefined,
            album: s.album_name ?? undefined,
          }),
        ),
      },
    }),
    200, XML,
  );
};

register("getRandomSongs", permissionMiddleware("browse"), getRandomSongsHandler);
