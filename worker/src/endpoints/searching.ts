import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { mapArtist, mapAlbum, mapSong } from "../types/subsonic";

export const searchRoutes = new Hono();

searchRoutes.get("/rest/search3", async (c) => {
  // Empty query = full listing (Navidrome-compatible) — the web Songs view relies on it
  const query = c.req.query("query") || "";

  const artistCount = parseInt(c.req.query("artistCount") || "20", 10);
  const artistOffset = parseInt(c.req.query("artistOffset") || "0", 10);
  const albumCount = parseInt(c.req.query("albumCount") || "20", 10);
  const albumOffset = parseInt(c.req.query("albumOffset") || "0", 10);
  const songCount = parseInt(c.req.query("songCount") || "20", 10);
  const songOffset = parseInt(c.req.query("songOffset") || "0", 10);

  const queries = createQueries((c.env as Env).DB);
  const result = await queries.search(query, {
    artistCount, artistOffset, albumCount, albumOffset, songCount, songOffset,
  });

  return c.text(
    subsonicOK({
      searchResult3: {
        artist: result.artists.map((a) => ({ _attributes: mapArtist(a) as unknown as Record<string, string> })),
        album: result.albums.map((a) => ({ _attributes: mapAlbum(a) as unknown as Record<string, string> })),
        song: result.songs.map((s) => ({
          _attributes: {
            ...(mapSong(s, s.album_id) as unknown as Record<string, string>),
            artist: s.artist_name ?? undefined,
            album: s.album_name ?? undefined,
          },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});
