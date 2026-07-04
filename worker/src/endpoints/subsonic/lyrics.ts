// 036 — Lyrics endpoints (Subsonic getLyrics + OpenSubsonic songLyrics ext).
//
// GET /rest/getLyrics?artist=<a>&title=<t>
//   Subsonic v1.2+ classic endpoint. Returns:
//     <lyrics artist="..." title="...">text</lyrics>
//   when found; an empty <lyrics/> element when not (still 200 OK).
//
// GET /rest/getLyricsBySongId?id=<songMasterId>
//   OpenSubsonic extension `songLyrics`. Returns a structuredLyrics list with
//   exactly one entry (synced=false because we always emit a single LRC blob).
//
// Resolution order is identical for both endpoints:
//   1. Look up song_masters.lyrics (filled by writeTags / prior fetch).
//   2. If empty, hit the external fetcher (NetEase). On hit, write back to
//      song_masters.lyrics so the next call is free.
//   3. Otherwise return the empty shell.

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { fetchExternalLyric } from "../../utils/lyricfetch";
import { fetchLrcSidecar } from "../../utils/lrcSidecar";
import { subsonicOK } from "../../utils/xml";
import { subsonicError } from "../../auth";

export const lyricsRoutes = new Hono();

// Reused by both endpoints: given a master row, return existing lyrics or
// fetch externally + persist. Never throws — fetch failures return null.
//
// 094 — Resolution order is now:
//   1. song_masters.lyrics (D1) — populated by writeTags / prior fetch /
//      scan-time .lrc sidecar import.
//   2. Sibling .lrc sidecar (R2 / WebDAV only). Local-first beats a round-trip
//      to NetEase and avoids needing the title/artist match heuristic for
//      files that already live next to the audio.
//   3. External fetcher (NetEase). On hit, write back to song_masters.lyrics
//      so the next call is free.
//   4. Otherwise return the empty shell.
async function resolveLyrics(
  env: Env,
  db: D1Database,
  masterId: string,
  artist: string | null,
  title: string | null,
  existing: string | null | undefined,
): Promise<string | null> {
  if (existing && existing.trim().length > 0) return existing;

  // 094 — Try a sibling .lrc sidecar next, before hitting NetEase. The
  // sidecar lookup needs a song_instances.storage_uri; pick the first
  // eligible instance (R2 preferred by getSongInstances' ordering). Only
  // r2:// and webdav:// URIs are eligible — url/subsonic short-circuit
  // inside fetchLrcSidecar.
  try {
    const queries = createQueries(db);
    const instances = await queries.getSongInstances(masterId);
    for (const inst of instances) {
      const lrc = await fetchLrcSidecar(env, inst.storage_uri);
      if (lrc) {
        // Persist for cache locality so the next call skips the R2/WebDAV
        // round-trip entirely. Best-effort — a transient D1 failure is
        // logged but never blocks the response.
        try {
          await db.prepare(
            "UPDATE song_masters SET lyrics = ?, updated_at = ? WHERE id = ?",
          ).bind(lrc, Math.floor(Date.now() / 1000), masterId).run();
        } catch {
          // intentionally silent.
        }
        return lrc;
      }
    }
  } catch {
    // Sidecar lookup must never break getLyrics.
  }

  const fetched = await fetchExternalLyric(artist, title);
  if (!fetched) return null;

  // Persist for cache locality. A failure here (e.g. transient D1) is logged
  // but never blocks the response — the caller still gets the freshly fetched
  // text.
  try {
    await db.prepare(
      "UPDATE song_masters SET lyrics = ?, updated_at = ? WHERE id = ?",
    )
      .bind(fetched, Math.floor(Date.now() / 1000), masterId)
      .run();
  } catch {
    // intentionally silent — see comment above.
  }
  return fetched;
}

// ---------------------------------------------------------------------------
// GET /rest/getLyrics?artist=<a>&title=<t>
// ---------------------------------------------------------------------------
lyricsRoutes.get("/getLyrics", async (c) => {
  const env = c.env as Env;
  const artist = c.req.query("artist") || "";
  const title = c.req.query("title") || "";

  // Subsonic spec allows the caller to omit both; the server should respond
  // with an empty <lyrics/> instead of an error. We mirror that.
  if (!title.trim() && !artist.trim()) {
    return c.text(
      subsonicOK({
        lyrics: { _attributes: { artist: "", title: "" } },
      }),
      200,
      { "Content-Type": "application/xml; charset=UTF-8" },
    );
  }

  // Look the song up by title (+ optional artist) so we can short-circuit on a
  // populated lyrics row. We don't gate on song_masters.id here — getLyrics
  // is title/artist keyed in the Subsonic spec.
  const db = env.DB;
  let row: { id: string; lyrics: string | null; artist_name: string | null; title: string | null } | null = null;
  if (title.trim()) {
    if (artist.trim()) {
      row = await db
        .prepare(
          `SELECT sm.id, sm.lyrics, ar.name AS artist_name, sm.title AS title
             FROM song_masters sm
             LEFT JOIN artists ar ON ar.id = sm.artist_id
            WHERE LOWER(sm.title) = LOWER(?)
              AND LOWER(IFNULL(ar.name, '')) = LOWER(?)
            LIMIT 1`,
        )
        .bind(title.trim(), artist.trim())
        .first();
    } else {
      row = await db
        .prepare(
          `SELECT sm.id, sm.lyrics, ar.name AS artist_name, sm.title AS title
             FROM song_masters sm
             LEFT JOIN artists ar ON ar.id = sm.artist_id
            WHERE LOWER(sm.title) = LOWER(?)
            LIMIT 1`,
        )
        .bind(title.trim())
        .first();
    }
  }

  let lyrics: string | null = null;
  if (row) {
    lyrics = await resolveLyrics(env, db, row.id, row.artist_name || artist, row.title || title, row.lyrics);
  } else if (title.trim()) {
    // No match in D1 — still try external, but we have no row to write back to.
    lyrics = await fetchExternalLyric(artist, title);
  }

  const responseArtist = row?.artist_name || artist || "";
  const responseTitle = row?.title || title || "";

  return c.text(
    subsonicOK({
      lyrics: {
        _attributes: { artist: responseArtist, title: responseTitle },
        ...(lyrics ? { _text: lyrics } : {}),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" },
  );
});

// ---------------------------------------------------------------------------
// GET /rest/getLyricsBySongId?id=<songMasterId>  (OpenSubsonic songLyrics)
// ---------------------------------------------------------------------------
lyricsRoutes.get("/getLyricsBySongId", async (c) => {
  const id = c.req.query("id");
  if (!id) {
    return c.text(
      subsonicError(10, "Missing id parameter"),
      400,
      { "Content-Type": "application/xml; charset=UTF-8" },
    );
  }

  const env = c.env as Env;
  const queries = createQueries(env.DB);
  const master = await queries.getSongMaster(id);
  if (!master) {
    return c.text(
      subsonicError(70, "Song not found"),
      404,
      { "Content-Type": "application/xml; charset=UTF-8" },
    );
  }

  // Pull the artist display name so external fetches + the response payload
  // have something to work with.
  const artistRow = await env.DB
    .prepare("SELECT name FROM artists WHERE id = ?")
    .bind(master.artist_id)
    .first<{ name: string }>();
  const artistName = artistRow?.name || "";

  const lyrics = await resolveLyrics(env, env.DB, master.id, artistName, master.title, master.lyrics);

  // OpenSubsonic `songLyrics` shape:
  //   <lyricsList>
  //     <structuredLyrics displayArtist="..." displayTitle="..." lang="xxx" synced="false">
  //       <line>line text</line>
  //       ...
  //     </structuredLyrics>
  //   </lyricsList>
  // When we have no lyrics, the spec allows an empty <lyricsList/> — that's
  // what clients use to render "no lyrics available" cleanly.
  const lines: string[] = lyrics ? lyrics.split(/\r?\n/).filter((l) => l.length > 0) : [];

  return c.text(
    subsonicOK({
      lyricsList: lyrics
        ? {
            structuredLyrics: {
              _attributes: {
                displayArtist: artistName,
                displayTitle: master.title,
                lang: "xxx",
                synced: "false",
              },
              line: lines.map((text) => ({ _text: text })),
            },
          }
        : { _attributes: {} },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" },
  );
});
