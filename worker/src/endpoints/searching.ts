import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { mapArtist, mapAlbum, mapSong, type AnnotationLite } from "../types/subsonic";
import type { User, Annotation } from "../types/entities";

export const searchRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// 035 — same helpers as browsing.ts. Inlined to avoid cross-file churn.
function currentUserId(c: import("hono").Context): string {
  return (c.get("user") as User | undefined)?.username ?? "";
}
function liteOf(row: Annotation | undefined): AnnotationLite | undefined {
  if (!row) return undefined;
  return {
    starred: row.starred,
    starred_at: row.starred_at,
    rating: row.rating,
    play_count: row.play_count,
  };
}

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

  // 035 — batch lookup annotations for each result group in a single roundtrip.
  const userId = currentUserId(c);
  const [artistAnn, albumAnn, songAnn] = await Promise.all([
    queries.getAnnotationsMap(userId, "artist", result.artists.map((a) => a.id)),
    queries.getAnnotationsMap(userId, "album", result.albums.map((a) => a.id)),
    queries.getAnnotationsMap(userId, "song", result.songs.map((s) => s.id)),
  ]);

  return c.text(
    subsonicOK({
      searchResult3: {
        artist: result.artists.map((a) => ({
          _attributes: mapArtist(a, liteOf(artistAnn.get(`artist:${a.id}`))) as unknown as Record<string, string>,
        })),
        album: result.albums.map((a) => ({
          _attributes: mapAlbum(a, undefined, liteOf(albumAnn.get(`album:${a.id}`))) as unknown as Record<string, string>,
        })),
        song: result.songs.map((s) => ({
          _attributes: {
            ...(mapSong(s, s.album_id, liteOf(songAnn.get(`song:${s.id}`))) as unknown as Record<string, string>),
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
