import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import { mapArtist, mapAlbum, mapSong, type AnnotationLite } from "../../types/subsonic";
import type { User, Annotation } from "../../types/entities";

export const searchRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

function currentUserId(c: Context): string {
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

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// search2 and search3 share the same ID3-organised query path; only the
// response root element differs (searchResult2 vs searchResult3).
// but what they actually SEND varies: Symfonium/DSub send the literal
// two-character string `""`, others send `*` or a bare empty param. Navidrome
// normalises all of these to the match-everything query; mirror that.
export function normalizeQuery(raw: string): string {
  const q = raw.trim();
  if (q === `""` || q === "''" || q === "*") return "";
  // strip one layer of wrapping quotes: `"beatles"` → `beatles`
  const m = /^"(.*)"$/.exec(q);
  return m ? m[1] : q;
}

const search23Handler = (tag: "searchResult2" | "searchResult3") =>
  async (c: Context): Promise<Response> => {
    // Empty query = full listing (Navidrome-compatible) — the web Songs view relies on it
    const query = normalizeQuery(c.req.query("query") || "");

    const artistCount = parseInt(c.req.query("artistCount") || "20", 10);
    const artistOffset = parseInt(c.req.query("artistOffset") || "0", 10);
    const albumCount = parseInt(c.req.query("albumCount") || "20", 10);
    const albumOffset = parseInt(c.req.query("albumOffset") || "0", 10);
    const songCount = parseInt(c.req.query("songCount") || "20", 10);
    const songOffset = parseInt(c.req.query("songOffset") || "0", 10);
    const songSort = c.req.query("songSort");

    const queries = createQueries((c.env as Env).DB);
    const result = await queries.search(query, {
      artistCount, artistOffset, albumCount, albumOffset, songCount, songOffset,
      songSort: songSort === "newest" || songSort === "oldest" || songSort === "titleDesc" ? songSort : "title",
    });

    const userId = currentUserId(c);
    const [artistAnn, albumAnn, songAnn] = await Promise.all([
      queries.getAnnotationsMap(userId, "artist", result.artists.map((a) => a.id)),
      queries.getAnnotationsMap(userId, "album", result.albums.map((a) => a.id)),
      queries.getAnnotationsMap(userId, "song", result.songs.map((s) => s.id)),
    ]);

    return c.text(
      subsonicOK({
        [tag]: {
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
      200, XML,
    );
  };

// search (v1, deprecated since 1.4.0) — file-structure search.
// Params: artist / album / title / any / count / offset / newerThan
// Response root: <searchResult>. We map onto the same ID3 queries (EdgeSonic
// has no separate file-structure index); the result shape matches searchResult
// which expects <match> children (artist/album/song mixed).
const search1Handler = async (c: Context): Promise<Response> => {
  const artistQ = c.req.query("artist") || "";
  const albumQ = c.req.query("album") || "";
  const titleQ = c.req.query("title") || "";
  const anyQ = c.req.query("any") || "";
  // 157: was capped at 500 for no documented reason, unlike search2/3 (this
  // handler's direct siblings below) which have never had a ceiling.
  const count = parseInt(c.req.query("count") || "20", 10) || 20;
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;

  // `any` falls back to a generic LIKE; the specific fields take precedence.
  const any = anyQ || artistQ || albumQ || titleQ || anyQ;

  const queries = createQueries((c.env as Env).DB);
  const result = await queries.search(any, {
    artistCount: count, artistOffset: offset,
    albumCount: count, albumOffset: offset,
    songCount: count, songOffset: offset,
  });

  const userId = currentUserId(c);
  const [artistAnn, albumAnn, songAnn] = await Promise.all([
    queries.getAnnotationsMap(userId, "artist", result.artists.map((a) => a.id)),
    queries.getAnnotationsMap(userId, "album", result.albums.map((a) => a.id)),
    queries.getAnnotationsMap(userId, "song", result.songs.map((s) => s.id)),
  ]);

  return c.text(
    subsonicOK({
      searchResult: {
        match: [
          ...result.artists.map((a) => ({
            _attributes: {
              ...(mapArtist(a, liteOf(artistAnn.get(`artist:${a.id}`))) as unknown as Record<string, string>),
              type: "artist",
            },
          })),
          ...result.albums.map((a) => ({
            _attributes: {
              ...(mapAlbum(a, undefined, liteOf(albumAnn.get(`album:${a.id}`))) as unknown as Record<string, string>),
              type: "album",
            },
          })),
          ...result.songs.map((s) => ({
            _attributes: {
              ...(mapSong(s, s.album_id, liteOf(songAnn.get(`song:${s.id}`))) as unknown as Record<string, string>),
              artist: s.artist_name ?? undefined,
              album: s.album_name ?? undefined,
              type: "song",
            },
          })),
        ],
      },
    }),
    200, XML,
  );
};

// ============================================================================
// Route registration — Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    searchRoutes.get(p, handler);
    searchRoutes.post(p, handler);
  }
}

register("search3", search23Handler("searchResult3"));
register("search2", search23Handler("searchResult2"));
register("search", search1Handler);
