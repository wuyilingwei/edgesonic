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
// Task 043 — Third-party metadata proxy (last.fm).
//
// Exposes the four Subsonic "info" endpoint families:
//   getArtistInfo  / getArtistInfo2
//   getAlbumInfo   / getAlbumInfo2
//   getSimilarSongs / getSimilarSongs2
//   getTopSongs
//
// All routes funnel through the last.fm client in worker/src/lib/lastfm.ts.
// When the api_key feature is empty, the client throws LastfmUnconfigured and
// we map that to Subsonic error code 30 ("not supported") — that way clients
// get a polite "feature off" response instead of a 500.
//
// Auth: these endpoints are *not* in SESSION_ONLY_PATHS — they're plain
// browsing data, identical access surface to getArtist / getAlbum.
// ============================================================================

import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { subsonicError } from "../auth";
import { mapSong } from "../types/subsonic";
import {
  LastfmUnconfigured,
  LastfmFetchError,
  getArtistInfo as lastfmGetArtistInfo,
  getAlbumInfo as lastfmGetAlbumInfo,
  getSimilarArtists as lastfmGetSimilarArtists,
  getSimilarTracks as lastfmGetSimilarTracks,
  getTopTracks as lastfmGetTopTracks,
} from "../lib/lastfm";
import type { Artist, SongMaster } from "../types/entities";

export const infoRoutes = new Hono<{ Bindings: Env }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// Wrap an async handler so any LastfmUnconfigured → code 30, any
// LastfmFetchError → code 0, anything else → code 0 with truncated message.
async function safeRun(
  c: Context<{ Bindings: Env }>,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LastfmUnconfigured) {
      return c.text(subsonicError(30, e.message), 200, XML);
    }
    if (e instanceof LastfmFetchError) {
      return c.text(subsonicError(0, e.message), 200, XML);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return c.text(subsonicError(0, msg.slice(0, 200)), 200, XML);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Map an artist name from last.fm onto an EdgeSonic artist row, if any.
// Case-insensitive exact match first; falls back to LIKE for tolerance to
// trailing whitespace / punctuation differences.
async function findArtistByName(db: D1Database, name: string): Promise<Artist | null> {
  const exact = await db.prepare(
    "SELECT * FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1"
  ).bind(name).first<Artist>();
  if (exact) return exact;
  return db.prepare(
    "SELECT * FROM artists WHERE name LIKE ? LIMIT 1"
  ).bind(name).first<Artist>();
}

// Map (title, artistName) onto an EdgeSonic song_master, if any.
// Joins artists so we only match within the right artist's catalogue.
async function findSongByTitleAndArtist(
  db: D1Database,
  title: string,
  artistName: string,
): Promise<(SongMaster & { artist_name?: string; album_name?: string }) | null> {
  const exact = await db.prepare(
    `SELECT sm.*, ar.name AS artist_name, al.name AS album_name
     FROM song_masters sm
     JOIN artists ar ON ar.id = sm.artist_id
     LEFT JOIN albums al ON al.id = sm.album_id
     WHERE LOWER(sm.title) = LOWER(?) AND LOWER(ar.name) = LOWER(?)
     LIMIT 1`
  ).bind(title, artistName).first<SongMaster & { artist_name?: string; album_name?: string }>();
  if (exact) return exact;
  return db.prepare(
    `SELECT sm.*, ar.name AS artist_name, al.name AS album_name
     FROM song_masters sm
     JOIN artists ar ON ar.id = sm.artist_id
     LEFT JOIN albums al ON al.id = sm.album_id
     WHERE sm.title LIKE ? AND ar.name LIKE ?
     LIMIT 1`
  ).bind(title, artistName).first<SongMaster & { artist_name?: string; album_name?: string }>();
}

// ---------------------------------------------------------------------------
// getArtistInfo / getArtistInfo2
// ---------------------------------------------------------------------------
async function artistInfoHandler(
  c: Context<{ Bindings: Env }>,
  tag: "artistInfo" | "artistInfo2",
): Promise<Response> {
  return safeRun(c, async () => {
    const id = c.req.query("id");
    if (!id) return c.text(subsonicError(10, "Required id parameter is missing"), 200, XML);

    const queries = createQueries(c.env.DB);
    const artist = await queries.getArtist(id);
    if (!artist) return c.text(subsonicError(70, "Artist not found"), 200, XML);

    const countRaw = parseInt(c.req.query("count") || "20", 10);
    const count = Math.max(1, Math.min(isNaN(countRaw) ? 20 : countRaw, 100));
    const includeNotPresent = (c.req.query("includeNotPresent") || "").toLowerCase() === "true";

    const [info, similar] = await Promise.all([
      lastfmGetArtistInfo(c.env, artist.name),
      lastfmGetSimilarArtists(c.env, artist.name, count).catch((e) => {
        // similarArtists failing shouldn't kill the whole response; biography
        // alone is still useful. Bubble up only LastfmUnconfigured.
        if (e instanceof LastfmUnconfigured) throw e;
        return [];
      }),
    ]);

    // Resolve each similar artist against local artists table.
    const similarRows: Array<{ name: string; id?: string; albumCount?: number }> = [];
    for (const s of similar) {
      const localArtist = await findArtistByName(c.env.DB, s.name);
      if (localArtist) {
        const albums = await queries.getAlbumsByArtist(localArtist.id);
        similarRows.push({ name: localArtist.name, id: localArtist.id, albumCount: albums.length });
      } else if (includeNotPresent) {
        // Spec: emit the similarArtist even though it's not in the library;
        // omit `id` so clients know it's a stub.
        similarRows.push({ name: s.name });
      }
    }

    const inner: Record<string, unknown> = {
      [tag]: {
        ...(info?.biography ? { biography: { _text: info.biography } } : {}),
        ...(info?.mbid ? { musicBrainzId: { _text: info.mbid } } : {}),
        ...(info?.url ? { lastFmUrl: { _text: info.url } } : {}),
        ...(info?.images.small ? { smallImageUrl: { _text: info.images.small } } : {}),
        ...(info?.images.medium ? { mediumImageUrl: { _text: info.images.medium } } : {}),
        ...(info?.images.large ? { largeImageUrl: { _text: info.images.large } } : {}),
        similarArtist: similarRows.map((r) => attrs(r)),
      },
    };
    return c.text(subsonicOK(inner), 200, XML);
  });
}

infoRoutes.get("/rest/getArtistInfo", (c) => artistInfoHandler(c, "artistInfo"));
infoRoutes.get("/rest/getArtistInfo2", (c) => artistInfoHandler(c, "artistInfo2"));

// ---------------------------------------------------------------------------
// getAlbumInfo / getAlbumInfo2
// ---------------------------------------------------------------------------
async function albumInfoHandler(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  return safeRun(c, async () => {
    const id = c.req.query("id");
    if (!id) return c.text(subsonicError(10, "Required id parameter is missing"), 200, XML);

    const queries = createQueries(c.env.DB);
    const album = await queries.getAlbum(id);
    if (!album) return c.text(subsonicError(70, "Album not found"), 200, XML);

    // Need an artist name to query last.fm. Pull from any song_master in this
    // album; if the album has no songs yet we can't query.
    const songs = await queries.getSongMastersByAlbum(id);
    let artistName: string | null = null;
    for (const s of songs) {
      const artistRow = await c.env.DB.prepare(
        "SELECT name FROM artists WHERE id = ?"
      ).bind(s.artist_id).first<{ name: string }>();
      if (artistRow?.name) { artistName = artistRow.name; break; }
    }
    if (!artistName) {
      return c.text(subsonicOK({ albumInfo: {} }), 200, XML);
    }

    const info = await lastfmGetAlbumInfo(c.env, artistName, album.name);
    const inner: Record<string, unknown> = {
      albumInfo: {
        ...(info?.notes ? { notes: { _text: info.notes } } : {}),
        ...(info?.mbid ? { musicBrainzId: { _text: info.mbid } } : {}),
        ...(info?.url ? { lastFmUrl: { _text: info.url } } : {}),
        ...(info?.images.small ? { smallImageUrl: { _text: info.images.small } } : {}),
        ...(info?.images.medium ? { mediumImageUrl: { _text: info.images.medium } } : {}),
        ...(info?.images.large ? { largeImageUrl: { _text: info.images.large } } : {}),
      },
    };
    return c.text(subsonicOK(inner), 200, XML);
  });
}

infoRoutes.get("/rest/getAlbumInfo", albumInfoHandler);
infoRoutes.get("/rest/getAlbumInfo2", albumInfoHandler);

// ---------------------------------------------------------------------------
// getSimilarSongs / getSimilarSongs2
// ---------------------------------------------------------------------------
async function similarSongsHandler(
  c: Context<{ Bindings: Env }>,
  tag: "similarSongs" | "similarSongs2",
): Promise<Response> {
  return safeRun(c, async () => {
    const id = c.req.query("id");
    if (!id) return c.text(subsonicError(10, "Required id parameter is missing"), 200, XML);

    const queries = createQueries(c.env.DB);
    const song = await queries.getSongMaster(id);
    if (!song) return c.text(subsonicError(70, "Song not found"), 200, XML);

    const artistRow = await c.env.DB.prepare(
      "SELECT name FROM artists WHERE id = ?"
    ).bind(song.artist_id).first<{ name: string }>();
    if (!artistRow?.name) {
      return c.text(subsonicOK({ [tag]: {} }), 200, XML);
    }

    const countRaw = parseInt(c.req.query("count") || "50", 10);
    const count = Math.max(1, Math.min(isNaN(countRaw) ? 50 : countRaw, 200));

    const similar = await lastfmGetSimilarTracks(c.env, artistRow.name, song.title, count);
    const matched: Array<SongMaster & { artist_name?: string; album_name?: string }> = [];
    for (const s of similar) {
      if (!s.artist) continue;
      const row = await findSongByTitleAndArtist(c.env.DB, s.name, s.artist);
      // Subsonic spec: drop unmatched silently — clients can't play foreign ids.
      if (row) matched.push(row);
    }

    return c.text(
      subsonicOK({
        [tag]: {
          song: matched.map((s) => attrs({
            ...mapSong(s, s.album_id),
            artist: s.artist_name ?? undefined,
            album: s.album_name ?? undefined,
          })),
        },
      }),
      200, XML,
    );
  });
}

infoRoutes.get("/rest/getSimilarSongs", (c) => similarSongsHandler(c, "similarSongs"));
infoRoutes.get("/rest/getSimilarSongs2", (c) => similarSongsHandler(c, "similarSongs2"));

// ---------------------------------------------------------------------------
// getTopSongs (047 — local-first, last.fm fallback)
//
// Strategy:
//   1. D1 first: select up to `count` song_masters for this artist ranked by
//      aggregated annotations.play_count DESC. This always runs, even when
//      lastfm_api_key is unset.
//   2. If we got fewer than `count`, ask last.fm for top tracks and reverse-
//      lookup each one back to a local song_master. Skip rows already in the
//      local list (dedupe by master id).
//   3. last.fm being unconfigured is NOT an error here: we silently keep
//      whatever the D1 step produced. Other last.fm fetch failures degrade
//      the same way — partial result over no result.
// ---------------------------------------------------------------------------
infoRoutes.get("/rest/getTopSongs", async (c) => {
  const artist = c.req.query("artist");
  if (!artist) return c.text(subsonicError(10, "Required artist parameter is missing"), 200, XML);

  const countRaw = parseInt(c.req.query("count") || "50", 10);
  const count = Math.max(1, Math.min(isNaN(countRaw) ? 50 : countRaw, 200));

  const queries = createQueries(c.env.DB);
  // Step 1: local D1 rank.
  const local = await queries.getTopSongsByArtist(artist, count);
  const matched: Array<SongMaster & { artist_name?: string | null; album_name?: string | null }> = [
    ...local,
  ];
  const seen = new Set(local.map((s) => s.id));

  // Step 2: top up from last.fm if room remains. Swallow LastfmUnconfigured
  // (lets the endpoint work in the no-key configuration) and LastfmFetchError
  // (transient network blip — keep whatever we have).
  if (matched.length < count) {
    try {
      const top = await lastfmGetTopTracks(c.env, artist, count);
      for (const t of top) {
        if (matched.length >= count) break;
        const row = await findSongByTitleAndArtist(c.env.DB, t.name, t.artist || artist);
        if (row && !seen.has(row.id)) {
          matched.push(row);
          seen.add(row.id);
        }
      }
    } catch (e) {
      if (!(e instanceof LastfmUnconfigured) && !(e instanceof LastfmFetchError)) {
        // Unexpected failure: surface via safeRun-style error wrapper, but
        // only when we have NO local rows — otherwise prefer partial result.
        if (matched.length === 0) {
          const msg = e instanceof Error ? e.message : String(e);
          return c.text(subsonicError(0, msg.slice(0, 200)), 200, XML);
        }
      }
    }
  }

  return c.text(
    subsonicOK({
      topSongs: {
        song: matched.map((s) => attrs({
          ...mapSong(s, s.album_id),
          artist: s.artist_name ?? undefined,
          album: s.album_name ?? undefined,
        })),
      },
    }),
    200, XML,
  );
});
