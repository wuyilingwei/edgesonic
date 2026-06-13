import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { mapArtist, mapAlbum, mapSong } from "../types/subsonic";

export const browsingRoutes = new Hono();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// Subsonic spec puts entity fields in XML attributes (and the web client's
// parseXmlAttrs only reads attributes) — every mapped object must be wrapped.
const attrs = (o: object) => ({ _attributes: o as Record<string, string | number | boolean | undefined> });

browsingRoutes.get("/rest/getArtists", async (c) => {
  const queries = createQueries((c.env as Env).DB);
  const artists = await queries.getArtists();

  return c.text(
    subsonicOK({ artists: { index: groupByLetter(artists.map(mapArtist)) } }),
    200, XML
  );
});

browsingRoutes.get("/rest/getArtist", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const artist = await queries.getArtist(id);
  if (!artist) return c.text(subsonicOK({}), 200, XML);

  const albums = await queries.getAlbumsByArtist(id);
  return c.text(
    subsonicOK({
      artist: {
        _attributes: { ...mapArtist(artist), albumCount: albums.length },
        album: albums.map((a) => attrs(mapAlbum(a, artist.name))),
      },
    }),
    200, XML
  );
});

browsingRoutes.get("/rest/getAlbum", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const album = await queries.getAlbum(id);
  if (!album) return c.text(subsonicOK({}), 200, XML);

  const songs = await queries.getSongMastersByAlbum(id);
  return c.text(
    subsonicOK({
      album: {
        _attributes: mapAlbum(album),
        song: songs.map((s) => attrs(mapSong(s, album.id))),
      },
    }),
    200, XML
  );
});

browsingRoutes.get("/rest/getSong", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const song = await queries.getSongMaster(id);
  if (!song) return c.text(subsonicOK({}), 200, XML);

  return c.text(
    subsonicOK({ song: attrs(mapSong(song, song.album_id)) }),
    200, XML
  );
});

browsingRoutes.get("/rest/getIndexes", async (c) => {
  const queries = createQueries((c.env as Env).DB);
  // Optional musicFolderId filter (038): "default" / "0" / "" → aggregate view.
  const musicFolderId = c.req.query("musicFolderId") || undefined;
  const indexes = await queries.getArtistIndexes(musicFolderId);

  return c.text(
    subsonicOK({
      indexes: {
        index: indexes.map((g) => ({
          _attributes: { name: g.letter },
          artist: g.artists.map((a) => attrs(mapArtist(a))),
        })),
      },
    }),
    200, XML
  );
});

browsingRoutes.get("/rest/getMusicFolders", async (c) => {
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
});

const albumList2Handler = async (c: import("hono").Context, tag: "albumList" | "albumList2") => {
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

  return c.text(
    subsonicOK({
      [tag]: {
        album: albums.map((a) =>
          attrs({ ...mapAlbum(a, a.artist_name ?? undefined), artistId: a.artist_id ?? undefined })
        ),
      },
    }),
    200, XML
  );
};

browsingRoutes.get("/rest/getAlbumList2", (c) => albumList2Handler(c, "albumList2"));
browsingRoutes.get("/rest/getAlbumList", (c) => albumList2Handler(c, "albumList"));

browsingRoutes.get("/rest/getGenres", async (c) => {
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
});

browsingRoutes.get("/rest/getSongsByGenre", async (c) => {
  const genre = c.req.query("genre");
  if (!genre) return c.text(subsonicOK({ songsByGenre: {} }), 200, XML);
  const count = Math.min(parseInt(c.req.query("count") || "10", 10) || 10, 500);
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;

  const queries = createQueries((c.env as Env).DB);
  const songs = await queries.getSongsByGenre(genre, count, offset);

  return c.text(
    subsonicOK({
      songsByGenre: {
        song: songs.map((s) => attrs(mapSong(s, s.album_id))),
      },
    }),
    200, XML
  );
});

browsingRoutes.get("/rest/getMusicDirectory", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, XML);

  const queries = createQueries((c.env as Env).DB);
  const album = await queries.getAlbum(id);
  if (album) {
    const songs = await queries.getSongMastersByAlbum(id);
    return c.text(
      subsonicOK({
        directory: {
          _attributes: { id: album.id, name: album.name },
          child: songs.map((s) => attrs(mapSong(s, album.id))),
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
});

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
