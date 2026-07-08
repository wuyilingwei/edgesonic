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
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import { mapArtist, mapAlbum, mapSong, type AnnotationLite } from "../../types/subsonic";
import type { User, Annotation } from "../../types/entities";

export const browsingRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// 035 — pull authenticated username for per-user annotation back-fill.
// Guest (level 0) bypasses auth on browse paths but still has c.get("user")
// populated by the middleware; if absent (e.g. unit tests without harness)
// we fall back to "" which yields an empty annotations Map.
function currentUserId(c: Context): string {
  return (c.get("user") as User | undefined)?.username ?? "";
}

// Convert a `annotations` row (snake_case columns) into the AnnotationLite
// shape mapXxx expects. Kept inline to avoid a per-row allocation explosion.
function liteOf(row: Annotation | undefined): AnnotationLite | undefined {
  if (!row) return undefined;
  return {
    starred: row.starred,
    starred_at: row.starred_at,
    rating: row.rating,
    play_count: row.play_count,
  };
}

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// Subsonic spec puts entity fields in XML attributes (and the web client's
// parseXmlAttrs only reads attributes) — every mapped object must be wrapped.
const attrs = (o: object) => ({ _attributes: o as Record<string, string | number | boolean | undefined> });

const getArtistsHandler = async (c: Context) => {
  const queries = createQueries((c.env as Env).DB);
  const artists = await queries.getArtists();
  const ann = await queries.getAnnotationsMap(currentUserId(c), "artist", artists.map((a) => a.id));

  return c.text(
    subsonicOK({
      artists: {
        index: groupByLetter(
          artists.map((a) => mapArtist(a, liteOf(ann.get(`artist:${a.id}`)))),
        ),
      },
    }),
    200, XML
  );
};

const getArtistHandler = async (c: Context) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const artist = await queries.getArtist(id);
  if (!artist) return c.text(subsonicOK({}), 200, XML);

  const albums = await queries.getAlbumsByArtist(id);
  const userId = currentUserId(c);
  const artistAnn = await queries.getAnnotationsMap(userId, "artist", [id]);
  const albumAnn = await queries.getAnnotationsMap(userId, "album", albums.map((a) => a.id));
  return c.text(
    subsonicOK({
      artist: {
        _attributes: {
          ...mapArtist(artist, liteOf(artistAnn.get(`artist:${id}`))),
          albumCount: albums.length,
        },
        album: albums.map((a) =>
          attrs(mapAlbum(a, artist.name, liteOf(albumAnn.get(`album:${a.id}`))))
        ),
      },
    }),
    200, XML
  );
};

const getAlbumHandler = async (c: Context) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const album = await queries.getAlbum(id);
  if (!album) return c.text(subsonicOK({}), 200, XML);

  const songs = await queries.getSongMastersByAlbum(id);
  const userId = currentUserId(c);
  const albumAnn = await queries.getAnnotationsMap(userId, "album", [id]);
  const songAnn = await queries.getAnnotationsMap(userId, "song", songs.map((s) => s.id));
  return c.text(
    subsonicOK({
      album: {
        _attributes: mapAlbum(album, undefined, liteOf(albumAnn.get(`album:${id}`))),
        song: songs.map((s) =>
          attrs(mapSong(s, album.id, liteOf(songAnn.get(`song:${s.id}`))))
        ),
      },
    }),
    200, XML
  );
};

const getSongHandler = async (c: Context) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const song = await queries.getSongMaster(id);
  if (!song) return c.text(subsonicOK({}), 200, XML);

  const ann = await queries.getAnnotationsMap(currentUserId(c), "song", [id]);
  return c.text(
    subsonicOK({ song: attrs(mapSong(song, song.album_id, liteOf(ann.get(`song:${id}`)))) }),
    200, XML
  );
};

const getIndexesHandler = async (c: Context) => {
  const queries = createQueries((c.env as Env).DB);
  // Optional musicFolderId filter (038): "default" / "0" / "" → aggregate view.
  const musicFolderId = c.req.query("musicFolderId") || undefined;
  const indexes = await queries.getArtistIndexes(musicFolderId);
  const allIds = indexes.flatMap((g) => g.artists.map((a) => a.id));
  const ann = await queries.getAnnotationsMap(currentUserId(c), "artist", allIds);

  return c.text(
    subsonicOK({
      indexes: {
        index: indexes.map((g) => ({
          _attributes: { name: g.letter },
          artist: g.artists.map((a) =>
            attrs(mapArtist(a, liteOf(ann.get(`artist:${a.id}`))))
          ),
        })),
      },
    }),
    200, XML
  );
};

const getMusicFoldersHandler = async (c: Context) => {
  const queries = createQueries((c.env as Env).DB);
  const sources = await queries.listEnabledSources();

  // Always emit the aggregate "Music" folder first (id="default") for
  // backward compatibility, followed by one folder per enabled source.
  const folders = [
    { id: "default", name: "Music" },
    ...sources.map((s) => ({ id: s.id, name: s.name?.trim() || s.base_url || s.id })),
  ];

  return c.text(
    subsonicOK({
      musicFolders: {
        musicFolder: folders.map((f) => attrs(f)),
      },
    }),
    200, XML
  );
};

const albumList2Handler = async (c: Context, tag: "albumList" | "albumList2") => {
  const type = c.req.query("type") || "newest";
  const size = Math.min(parseInt(c.req.query("size") || "10", 10) || 10, 500);
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;
  const fromYearRaw = c.req.query("fromYear");
  const toYearRaw = c.req.query("toYear");
  const fromYear = fromYearRaw !== undefined ? (parseInt(fromYearRaw, 10) || undefined) : undefined;
  const toYear = toYearRaw !== undefined ? (parseInt(toYearRaw, 10) || undefined) : undefined;
  const genre = c.req.query("genre") || undefined;
  const musicFolderId = c.req.query("musicFolderId") || undefined;

  const queries = createQueries((c.env as Env).DB);
  const albums = await queries.listAlbums(type, size, offset, {
    fromYear, toYear, genre, musicFolderId,
  });
  const ann = await queries.getAnnotationsMap(currentUserId(c), "album", albums.map((a) => a.id));

  return c.text(
    subsonicOK({
      [tag]: {
        album: albums.map((a) =>
          attrs({
            ...mapAlbum(a, a.artist_name ?? undefined, liteOf(ann.get(`album:${a.id}`))),
            artistId: a.artist_id ?? undefined,
          })
        ),
      },
    }),
    200, XML
  );
};

const getAlbumList2Handler = (c: Context) => albumList2Handler(c, "albumList2");
const getAlbumListHandler = (c: Context) => albumList2Handler(c, "albumList");

const getGenresHandler = async (c: Context) => {
  const queries = createQueries((c.env as Env).DB);
  const genres = await queries.getGenres();

  return c.text(
    subsonicOK({
      genres: {
        genre: genres.map((g) => ({
          _attributes: { songCount: g.songCount, albumCount: g.albumCount },
          _text: g.genre,
        })),
      },
    }),
    200, XML
  );
};

const getSongsByGenreHandler = async (c: Context) => {
  const genre = c.req.query("genre");
  if (!genre) return c.text(subsonicOK({ songsByGenre: {} }), 200, XML);
  const count = Math.min(parseInt(c.req.query("count") || "10", 10) || 10, 500);
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;

  const queries = createQueries((c.env as Env).DB);
  const songs = await queries.getSongsByGenre(genre, count, offset);
  const ann = await queries.getAnnotationsMap(currentUserId(c), "song", songs.map((s) => s.id));

  return c.text(
    subsonicOK({
      songsByGenre: {
        song: songs.map((s) =>
          attrs(mapSong(s, s.album_id, liteOf(ann.get(`song:${s.id}`))))
        ),
      },
    }),
    200, XML
  );
};

const getMusicDirectoryHandler = async (c: Context) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const userId = currentUserId(c);
  const album = await queries.getAlbum(id);
  if (album) {
    const songs = await queries.getSongMastersByAlbum(id);
    const ann = await queries.getAnnotationsMap(userId, "song", songs.map((s) => s.id));
    return c.text(
      subsonicOK({
        directory: {
          _attributes: { id: album.id, name: album.name },
          child: songs.map((s) =>
            attrs(mapSong(s, album.id, liteOf(ann.get(`song:${s.id}`))))
          ),
        },
      }),
      200, XML
    );
  }

  const artist = await queries.getArtist(id);
  if (artist) {
    const albums = await queries.getAlbumsByArtist(id);
    return c.text(
      subsonicOK({
        directory: {
          _attributes: { id: artist.id, name: artist.name },
          child: albums.map((a) =>
            attrs({
              id: a.id, parent: artist.id,
              isDir: "true", title: a.name,
              album: a.name, artist: artist.name,
              year: a.year ?? undefined,
              genre: a.genre ?? undefined,
              coverArt: a.cover_r2_key ? `al-${a.id}` : undefined,
              isVideo: "false",
            })
          ),
        },
      }),
      200, XML
    );
  }

  return c.text(subsonicOK({}), 200, XML);
};

function groupByLetter(items: ReturnType<typeof mapArtist>[]) {
  const groups: Record<string, ReturnType<typeof mapArtist>[]> = {};
  for (const item of items) {
    const letter = item.name.charAt(0).toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(item);
  }
  return Object.entries(groups).map(([name, artists]) => ({
    _attributes: { name },
    artist: artists.map((a) => ({ _attributes: a as unknown as Record<string, string | number | boolean | undefined> })),
  }));
}

// ============================================================================
// Route registration — Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    browsingRoutes.get(p, handler);
    browsingRoutes.post(p, handler);
  }
}

register("getArtists", getArtistsHandler);
register("getArtist", getArtistHandler);
register("getAlbum", getAlbumHandler);
register("getSong", getSongHandler);
register("getIndexes", getIndexesHandler);
register("getMusicFolders", getMusicFoldersHandler);
register("getAlbumList2", getAlbumList2Handler);
register("getAlbumList", getAlbumListHandler);
register("getGenres", getGenresHandler);
register("getSongsByGenre", getSongsByGenreHandler);
register("getMusicDirectory", getMusicDirectoryHandler);
