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

//
// GET /rest/getLyrics?artist=<a>&title=<t>
//  Subsonic v1.2+ classic endpoint. Returns:
//   <lyrics artist="..." title="...">text</lyrics>
//  when found; an empty <lyrics/> element when not (still 200 OK).
//
// GET /rest/getLyricsBySongId?id=<songMasterId>
//  OpenSubsonic extension `songLyrics`. With `enhanced=true` (v2) returns
//  the full cueLine/cue/agents/kind structure from song_masters.lyrics_rich;
//  without it (v1) emits a single structuredLyrics entry derived from the
//  line-level LRC stored in song_masters.lyrics.
//
// Resolution order is identical for both endpoints:
//  1. Look up song_masters.lyrics (filled by writeTags / prior fetch) and
//    song_masters.lyrics_rich (filled by TTML/KRC/enhanced-LRC sidecar or
//    NetEase klyric).
//  2. If lyrics_rich is empty, try a sibling rich sidecar (.ttml / .krc /
//    enhanced .lrc) and persist to lyrics_rich.
//  3. If lyrics is empty, try a sibling .lrc sidecar.
//  4. If both empty, hit the external fetcher (NetEase, including klyric for
//    the rich path) and persist on hit.
//  5. Otherwise return the empty shell.

import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { fetchExternalLyric, fetchExternalLyricRich } from "../../utils/lyricfetch";
import { fetchLrcSidecar, fetchSidecarRich } from "../../utils/lrcSidecar";
import {
  deserializeRich,
  parseEnhancedLrcToRich,
  parseLrcToRich,
  serializeRich,
  type RichLyrics,
  type RichTrack,
} from "../../utils/richLyrics";
import { subsonicOK } from "../../utils/xml";
import { subsonicError } from "../../auth";
import { ensureRichLyricsColumn } from "../../utils/schema_patch";

export const lyricsRoutes = new Hono();

// Reused by both endpoints: given a master row, return existing lyrics or
// fetch externally + persist. Never throws — fetch failures return null.
//
// 1. song_masters.lyrics (D1) — populated by writeTags / prior fetch /
//    scan-time .lrc sidecar import.
// 2. Sibling .lrc sidecar (R2 / WebDAV only). Local-first beats a round-trip
//    to NetEase and avoids needing the title/artist match heuristic for
//    files that already live next to the audio.
// 3. External fetcher (NetEase). On hit, write back to song_masters.lyrics
//    so the next call is free.
// 4. Otherwise return the empty shell.
async function resolveLyrics(
  env: Env,
  db: D1Database,
  masterId: string,
  artist: string | null,
  title: string | null,
  existing: string | null | undefined,
): Promise<string | null> {
  if (existing && existing.trim().length > 0) return existing;

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

// 0259 — rich-lyrics resolver. Returns a parsed RichLyrics payload (with
// cueLine/cue/agents) when a word-level source is available, else null.
// Resolution order:
//  1. song_masters.lyrics_rich (D1) — populated by scan-time TTML/KRC sidecar
//    import or a prior fetch.
//  2. Sibling rich sidecar (.ttml / .krc / enhanced .lrc) via fetchSidecarRich.
//  3. NetEase klyric via fetchExternalLyricRich — the `klyric.klyric` field
//    parses as enhanced LRC.
//  4. Fall back to song_masters.lyrics parsed at line level when only a
//    plain LRC is available — returned as a single-track RichLyrics so the
//    v1 caller shape stays identical.
//
// `enhanced` controls whether the caller wants the full cueLine/agents
// payload (v2) or the line-only v1 shape. When `enhanced=false` and
// `lyrics_rich` is populated, we still return the rich payload — the
// serializer strips cueLine/agents for v1 responses. The flag only affects
// whether we attempt extra sidecar / klyric fetches when lyrics_rich is
// empty (v2 callers want word-level data; v1 callers are happy with the
// line-level LRC already in `lyrics`).
async function resolveRichLyrics(
  env: Env,
  db: D1Database,
  masterId: string,
  artist: string | null,
  title: string | null,
  existingRich: string | null | undefined,
  existingLrc: string | null | undefined,
  enhanced: boolean,
): Promise<RichLyrics | null> {
  // 1. Already-populated rich column.
  const cached = deserializeRich(existingRich);
  if (cached && cached.tracks.length > 0) return cached;

  // 2. Sibling rich sidecar (only worth the R2/WebDAV round-trip when the
  // caller asked for enhanced; v1 callers are satisfied by `lyrics`).
  if (enhanced) {
    try {
      const queries = createQueries(db);
      const instances = await queries.getSongInstances(masterId);
      for (const inst of instances) {
        const rich = await fetchSidecarRich(env, inst.storage_uri);
        if (rich) {
          try {
            await db.prepare(
              "UPDATE song_masters SET lyrics_rich = ?, updated_at = ? WHERE id = ?",
            ).bind(serializeRich(rich), Math.floor(Date.now() / 1000), masterId).run();
          } catch {
            // intentionally silent.
          }
          return rich;
        }
      }
    } catch {
      // Sidecar lookup must never break getLyricsBySongId.
    }

    // 3. NetEase klyric. Only fetched when enhanced is requested — v1
    //    callers don't need word-level data and this would double the
    //    external request count.
    const fetched = await fetchExternalLyricRich(artist, title);
    if (fetched?.klyric) {
      const parsed = parseEnhancedLrcToRich(fetched.klyric);
      if (parsed) {
        try {
          await db.prepare(
            "UPDATE song_masters SET lyrics_rich = ?, updated_at = ? WHERE id = ?",
          ).bind(serializeRich(parsed), Math.floor(Date.now() / 1000), masterId).run();
        } catch {
          // intentionally silent.
        }
        return parsed;
      }
    }
  }

  // 4. Fall back to line-level LRC parsed into a single-track RichLyrics so
  //    the serializer can reuse the same code path for v1 responses. If the
  //    LRC is also empty, return null — the endpoint emits an empty list.
  if (existingLrc && existingLrc.trim().length > 0) {
    return parseLrcToRich(existingLrc);
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /rest/getLyrics?artist=<a>&title=<t>
// ---------------------------------------------------------------------------
const getLyricsHandler = async (c: Context): Promise<Response> => {
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
};

// ---------------------------------------------------------------------------
// GET /rest/getLyricsBySongId?id=<songMasterId>[&enhanced=true|false]
// (OpenSubsonic songLyrics v1 / v2)
// ---------------------------------------------------------------------------
const getLyricsBySongIdHandler = async (c: Context): Promise<Response> => {
  const id = c.req.query("id");
  if (!id) {
    return c.text(
      subsonicError(10, "Missing id parameter"),
      400,
      { "Content-Type": "application/xml; charset=UTF-8" },
    );
  }

  const env = c.env as Env;
  await ensureRichLyricsColumn(env);
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

  const enhanced = parseEnhancedFlag(c.req.query("enhanced"));

  // Resolve the rich payload (cueLine/agents when available; line-level
  // fallback otherwise). We also resolve the line-level LRC so the v1
  // response shape stays identical for clients that didn't opt in.
  const rich = await resolveRichLyrics(
    env, env.DB, master.id, artistName, master.title,
    (master as { lyrics_rich?: string | null }).lyrics_rich,
    master.lyrics,
    enhanced,
  );

  // When no rich payload (and no LRC), still try the line-level resolver so
  // a fresh external fetch has a chance to populate `lyrics`.
  let lineLyrics: string | null = master.lyrics ?? null;
  if (!rich) {
    lineLyrics = await resolveLyrics(env, env.DB, master.id, artistName, master.title, master.lyrics);
  }

  if (!rich && !lineLyrics) {
    // Spec allows an empty <lyricsList/> — clients render "no lyrics
    // available" cleanly.
    return c.text(
      subsonicOK({ lyricsList: { _attributes: {} } }),
      200,
      { "Content-Type": "application/xml; charset=UTF-8" },
    );
  }

  // Build the response. When we have a rich payload, emit one
  // <structuredLyrics> per RichTrack (main/translation/pronunciation),
  // including cueLine/agents when `enhanced=true`. When we only have the
  // line-level LRC, emit a single v1-shaped entry.
  const structured: unknown[] = [];
  if (rich) {
    for (const track of rich.tracks) {
      structured.push(serializeTrack(track, artistName, master.title, enhanced));
    }
  } else if (lineLyrics) {
    const parsed = parseLrc(lineLyrics);
    structured.push({
      _attributes: {
        displayArtist: artistName,
        displayTitle: master.title,
        lang: "xxx",
        synced: parsed.synced ? "true" : "false",
      },
      line: parsed.lines.map((l) => ({
        _attributes: l.start !== undefined ? { start: l.start } : {},
        _text: l.value,
      })),
    });
  }

  return c.text(
    subsonicOK({ lyricsList: { structuredLyrics: structured } }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" },
  );
};

// Parse the `enhanced` query flag. Spec: `false` is the default. We accept
// the usual Subsonic boolean spellings so mis-cased clients still opt in.
function parseEnhancedFlag(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// Serialize a RichTrack to the OpenSubsonic XML/JSON shape. When
// `enhanced=false` (v1), strip `kind`, `cueLine`, and `agents` so the
// response matches the v1 contract exactly.
function serializeTrack(
  track: RichTrack,
  artistName: string,
  title: string,
  enhanced: boolean,
): unknown {
  const attrs: Record<string, string | number | boolean | undefined> = {
    displayArtist: track.displayArtist ?? artistName,
    displayTitle: track.displayTitle ?? title,
    lang: track.lang,
    synced: track.synced,
  };
  if (track.offset !== undefined) attrs.offset = track.offset;
  if (enhanced && track.kind !== "main") attrs.kind = track.kind;

  const lineEntries = track.line.map((l) => ({
    _attributes: l.start !== undefined ? { start: l.start } : {},
    _text: l.value,
  }));

  const out: Record<string, unknown> = {
    _attributes: attrs,
    line: lineEntries,
  };

  if (enhanced) {
    if (track.cueLine.length > 0) {
      out.cueLine = track.cueLine.map((cl) => {
        const clAttrs: Record<string, string | number | boolean | undefined> = {
          index: cl.index,
        };
        if (cl.start !== undefined) clAttrs.start = cl.start;
        if (cl.end !== undefined) clAttrs.end = cl.end;
        if (cl.value !== undefined) clAttrs.value = cl.value;
        if (cl.agentId !== undefined) clAttrs.agentId = cl.agentId;
        return {
          _attributes: clAttrs,
          cue: cl.cue.map((cu) => ({
            _attributes: {
              start: cu.start,
              ...(cu.end !== undefined ? { end: cu.end } : {}),
              value: cu.value,
              byteStart: cu.byteStart,
              byteEnd: cu.byteEnd,
            },
          })),
        };
      });
    }
    if (track.agents.length > 0) {
      out.agents = track.agents.map((a) => ({
        _attributes: {
          id: a.id,
          role: a.role,
          ...(a.name ? { name: a.name } : {}),
        },
      }));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Timestamped lines ("[mm:ss.xx]text", repeated timestamps allowed) become
// {start: ms, value} entries sorted by start; pure metadata tag lines
// ("[ti:..]", "[ar:..]", "[by:..]", "[offset:..]"...) are dropped; if the
// blob has no timestamps at all, every non-empty line passes through
// unsynced (plain-text lyrics from external fetchers).
// ---------------------------------------------------------------------------
const LRC_TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(lyrics: string): {
  synced: boolean;
  lines: Array<{ start?: number; value: string }>;
} {
  const out: Array<{ start?: number; value: string }> = [];
  let synced = false;
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stamps = [...line.matchAll(LRC_TS)];
    if (stamps.length > 0 && line.startsWith("[")) {
      const text = line.replace(LRC_TS, "").trim();
      for (const m of stamps) {
        const frac = (m[3] ?? "0").padEnd(3, "0").slice(0, 3);
        out.push({
          start: parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + parseInt(frac, 10),
          value: text,
        });
      }
      synced = true;
      continue;
    }
    // Metadata tag line like [ti:xxx] / [by:xxx] — not lyrics content.
    if (/^\[[a-zA-Z#][^\]]*\]$/.test(line)) continue;
    out.push({ value: line });
  }
  if (synced) out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return { synced, lines: out };
}

// ============================================================================
// Route registration — Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    lyricsRoutes.get(p, handler);
    lyricsRoutes.post(p, handler);
  }
}

register("getLyrics", getLyricsHandler);
register("getLyricsBySongId", getLyricsBySongIdHandler);
