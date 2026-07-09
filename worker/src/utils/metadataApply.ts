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

// 077 — Shared metadata-apply helper + 041 relinkArtistAlbum primitive.
// ----------------------------------------------------------------------------
// Three call sites funnel through here:
//   1. 041 POST /tag/submit — the legacy "Files browser parsed locally" path.
//   2. 052a POST /edgesonic/work/submit (success branch) — the worker-pool path
//      that previously only marked work_queue rows 'completed' and forgot to
//      cascade onto song_masters / song_instances (the bug 077 fixes).
//   3. /edgesonic/work/backfillCompleted — replays old completed rows whose
//      apply step was skipped before the fix landed.
//
// We pulled SubmittedMetadata + relinkArtistAlbum out of endpoints/tag/submit.ts
// to here so that file (which imports this one for applyMetadataResult) doesn't
// create an import cycle. tag/submit.ts re-exports both symbols for any caller
// that historically pulled them from the old location.
//
// Design rules:
//   * Never throw on partial data — the caller usually can't recover and the
//     enclosing flow (work/submit, backfill) must keep going.
//   * Inputs are scrubbed to ints/floats before SQL binds — taskExecutor sends
//     year/track/disc as strings, the legacy /tag/submit cleanInput does the
//     same coercion; we replicate that here so neither caller has to know.
//   * tag_scanned ALWAYS flips to 1 after a successful UPDATE — that's the
//     bug we're fixing. A row that produced no useful tags still counts as
//     "seen" so a future scan does not re-queue the work forever.

import { md5 } from "./md5";

// ---------------------------------------------------------------------------
// SubmittedMetadata — the 041 wire shape, also reused as the merged form that
// applyMetadataResult feeds to relinkArtistAlbum. Kept here so the helper has
// no upward dependency on endpoints/*.
// ---------------------------------------------------------------------------
export interface SubmittedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  track?: number;
  disc?: number;
  duration?: number;     // seconds
  bitrate?: number;      // kbps
  sampleRate?: number;   // Hz
  channels?: number;
  lyrics?: string;       // 109 — persisted to song_masters.lyrics (COALESCE-guarded, see applyMetadataResult)
  container?: string;
  codec?: string;
}

// ---------------------------------------------------------------------------
// Loose input shapes used by applyMetadataResult so the work-pool caller can
// splat whatever music-metadata gave them. We only consume known fields.
// ---------------------------------------------------------------------------
export interface MetaCommon {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  albumArtist?: unknown;
  genre?: unknown;
  year?: unknown;
  track?: unknown;
  disc?: unknown;
  lyrics?: unknown;
}
export interface MetaFormat {
  bitrate?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  duration?: unknown;
  container?: unknown;
  codec?: unknown;
}

export interface ApplyResult {
  updated: boolean;
  masterId?: string;
  reason?: string;     // populated on `updated:false` to help admins debug backfill failures
}

// ---------------------------------------------------------------------------
// applyMetadataResult — main entry point.
// ----------------------------------------------------------------------------
// Returns { updated:true, masterId } on success.
// Returns { updated:false, reason } when the instance/master is missing or
// when the payload had no usable tag/format fields at all (we still don't
// throw — callers prefer a structured outcome over try/catch).
// ---------------------------------------------------------------------------
export async function applyMetadataResult(
  db: D1Database,
  instanceId: string,
  common: MetaCommon | undefined | null,
  format: MetaFormat | undefined | null,
): Promise<ApplyResult> {
  if (!instanceId || typeof instanceId !== "string") {
    return { updated: false, reason: "missing instanceId" };
  }

  // Merge common + format into the SubmittedMetadata shape that relinkArtist
  // Album already speaks. We re-coerce every scalar so a worker that emits
  // year:"2024" (string) lands the same as a 041 caller emitting year:2024.
  const tags = mergeToSubmitted(common ?? {}, format ?? {});

  // Even if no useful field came through, we still want to flip tag_scanned.
  // A row that was seen by the browser parser and produced nothing of value
  // shouldn't be re-queued forever. We branch below so we don't run relink
  // on an empty patch (relinkArtistAlbum would replace artist/album with
  // "Unknown ..." sentinel values, which would be actively harmful).
  const hasLogical =
    !!(tags.title || tags.artist || tags.album || tags.albumArtist ||
       tags.genre || tags.year || tags.track || tags.disc);

  const inst = await db.prepare(
    "SELECT id, master_id FROM song_instances WHERE id = ?",
  ).bind(instanceId).first<{ id: string; master_id: string }>();
  if (!inst) return { updated: false, reason: "instance not found" };

  let masterId: string | undefined;
  if (hasLogical) {
    const master = await db.prepare(
      "SELECT id, album_id, artist_id, title FROM song_masters WHERE id = ?",
    ).bind(inst.master_id).first<{
      id: string; album_id: string; artist_id: string; title: string;
    }>();
    if (!master) return { updated: false, reason: "master not found" };
    await relinkArtistAlbum(db, master, tags);
    masterId = master.id;
  } else {
    masterId = inst.master_id;
  }

  // 109 — lyrics is not a "logical" field for the relink gate above (relink
  // decides artist/album linkage; lyrics never should), so it needs its own
  // write independent of hasLogical — a submission carrying ONLY lyrics (no
  // title/artist/etc, e.g. a re-scan that only turned up an embedded LYRICS
  // tag) must still land. COALESCE(NULLIF(lyrics,''), ?) only fills an EMPTY
  // column: a user-authored edit or a NetEase/.lrc-sidecar fetch (036/094)
  // already in song_masters.lyrics is never clobbered by a lower-priority
  // embedded tag on a later re-scan.
  if (tags.lyrics) {
    await db.prepare(
      "UPDATE song_masters SET lyrics = COALESCE(NULLIF(lyrics, ''), ?), updated_at = ? WHERE id = ?",
    ).bind(tags.lyrics, Math.floor(Date.now() / 1000), inst.master_id).run();
  }

  // Update physical params on the instance row (only fields the payload had).
  // tag_scanned is always set to 1 — this is the part the old /work/submit
  // forgot, and the symptom Rosmontis observed (82 completed but only 1 row
  // with tag_scanned=1).
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof tags.bitrate === "number")    { sets.push("bit_rate = ?");    binds.push(tags.bitrate); }
  if (typeof tags.sampleRate === "number") { sets.push("sample_rate = ?"); binds.push(tags.sampleRate); }
  if (typeof tags.channels === "number")   { sets.push("channels = ?");    binds.push(tags.channels); }
  if (typeof tags.duration === "number")   { sets.push("duration = ?");    binds.push(tags.duration); }
  sets.push("tag_scanned = 1");
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(inst.id);
  await db.prepare(`UPDATE song_instances SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds).run();

  return { updated: true, masterId };
}

// ---------------------------------------------------------------------------
// relinkArtistAlbum — pulled in from endpoints/tag/submit.ts in 077 so the
// helper can call it directly. Behaviour is byte-for-byte identical to the
// 041 implementation:
//   * md5(linkArtistName)[:10] -> artist id
//   * md5(linkArtistName + " " + albumName)[:10] -> album id
//   * INSERT OR IGNORE both, UPDATE song_masters with the new fk's
//   * Refresh album song_count/size aggregates for old + new ids
//   * Sweep empty artist/album rows
// ---------------------------------------------------------------------------
export async function relinkArtistAlbum(
  db: D1Database,
  master: { id: string; album_id: string; artist_id: string; title: string },
  tags: SubmittedMetadata,
): Promise<{ albumId: string; artistId: string }> {
  const now = Math.floor(Date.now() / 1000);

  // Look up the current artist/album names so we can keep them when the patch
  // omits the field (same fallback chain as tagedit.ts).
  const curArtist = await db.prepare("SELECT name FROM artists WHERE id = ?")
    .bind(master.artist_id).first<{ name: string }>();
  const curAlbum = await db.prepare("SELECT name FROM albums WHERE id = ?")
    .bind(master.album_id).first<{ name: string }>();

  const title = tags.title || master.title;
  const artistName = tags.artist || curArtist?.name || "Unknown Artist";
  const linkArtistName = tags.albumArtist || artistName;
  const albumName = tags.album || curAlbum?.name || "Unknown Album";
  const artistId = "ar-" + md5(linkArtistName).substring(0, 10);
  const albumId = "al-" + md5(linkArtistName + " " + albumName).substring(0, 10);
  const oldAlbumId = master.album_id;

  await db.batch([
    db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(artistId, linkArtistName, linkArtistName.toLowerCase(), now, now),
    db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, tags.genre ?? null, now, now),
    db.prepare(
      `UPDATE song_masters SET
         album_id = ?, artist_id = ?, title = ?, sort_title = ?,
         track = COALESCE(?, track), disc = COALESCE(?, disc),
         genre = COALESCE(?, genre), duration = COALESCE(?, duration),
         updated_at = ?
       WHERE id = ?`,
    ).bind(
      albumId, artistId, title, title.toLowerCase(),
      tags.track ?? null, tags.disc ?? null,
      tags.genre ?? null, tags.duration ?? null,
      now, master.id,
    ),
  ]);

  // Backfill year / genre onto the freshly anchored album row (INSERT OR IGNORE
  // above skipped them when the row already existed).
  if (tags.year || tags.genre) {
    await db.prepare("UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?")
      .bind(tags.year ?? null, tags.genre ?? null, now, albumId).run();
  }

  // Refresh aggregates for both the new and the vacated album, then sweep empties.
  for (const aid of new Set([albumId, oldAlbumId])) {
    await db.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
         size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                 JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
         updated_at = ?
       WHERE id = ?`,
    ).bind(aid, aid, now, aid).run();
  }
  await db.prepare("DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id)").run();
  await db.prepare(
    "DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id)",
  ).run();

  return { albumId, artistId };
}

// ---------------------------------------------------------------------------
// mergeToSubmitted — coerces a loose common+format pair into the strict
// SubmittedMetadata shape relinkArtistAlbum + the legacy /tag/submit logic
// already accept. Same coercion rules as the 041 cleanInput so the two paths
// produce byte-identical UPDATEs.
// ---------------------------------------------------------------------------
function mergeToSubmitted(c: MetaCommon, f: MetaFormat): SubmittedMetadata {
  const out: SubmittedMetadata = {};
  const t = trimStr(c.title);        if (t) out.title       = t;
  const ar = trimStr(c.artist);      if (ar) out.artist      = ar;
  const al = trimStr(c.album);       if (al) out.album       = al;
  const aa = trimStr(c.albumArtist); if (aa) out.albumArtist = aa;
  const g = trimStr(c.genre);        if (g) out.genre       = g;

  const year = toPosInt(c.year);     if (year !== null) out.year  = year;
  const track = toPosInt(c.track);   if (track !== null) out.track = track;
  const disc = toPosInt(c.disc);     if (disc !== null) out.disc  = disc;
  const ly = trimStr(c.lyrics);      if (ly) out.lyrics = ly;

  const dur = toPosNum(f.duration);  if (dur !== null) out.duration   = dur;
  const br = toPosNum(f.bitrate);    if (br !== null) out.bitrate    = br;
  const sr = toPosNum(f.sampleRate); if (sr !== null) out.sampleRate = sr;
  const ch = toPosNum(f.channels);   if (ch !== null) out.channels   = ch;
  const cont = trimStr(f.container); if (cont) out.container = cont;
  const cdc = trimStr(f.codec);      if (cdc) out.codec     = cdc;
  return out;
}

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}
function toPosInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  return null;
}
function toPosNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}
