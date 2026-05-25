import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { mapArtist, mapAlbum, mapSong } from "../types/subsonic";

export const searchRoutes = new Hono();

searchRoutes.get("/rest/search3", async (c) => {
  const query = c.req.query("query") || "";
  if (!query) {
    return c.text(subsonicOK({ searchResult3: {} }), 200, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

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
        artist: result.artists.map(mapArtist),
        album: result.albums.map((a) => mapAlbum(a)),
        song: result.songs.map((s) => mapSong(s, s.album_id)),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});
