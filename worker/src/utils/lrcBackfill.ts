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

// 113 — Batch LRC sidecar backfill for the pre-existing library.
// ---------------------------------------------------------------------------
// 094 wired fetchLrcSidecar/importLrcOnScan into two places: scan.ts (only for
// brand-new song_instances INSERTs) and lyrics.ts's getLyrics endpoint (only
// when a client actually requests lyrics for that song). Neither path
// retroactively checks songs that were scanned before 094 shipped, or that
// nobody has ever played — a sibling .lrc file sitting right next to those
// tracks is never looked at. This closes that gap with a cron-driven batch
// pass, mirroring metadataRecheck.ts's cadence/kv_store-throttle shape, but
// doing the work directly instead of dispatching to the browser worker pool:
// a sidecar read is a small (<=100KB) R2/WebDAV GET the Worker can do itself,
// it doesn't need audio decoding.
//
// Candidates are song_masters with empty lyrics that have at least one
// source_type='original' r2:// or webdav:// instance (cached/transcoded
// instances point at synthetic cache paths with no meaningful sibling file).
// A candidate with no sidecar hit stays a candidate forever (lyrics stays
// empty) and will be re-selected on the next tick — cheap (one 404) but worth
// knowing; unlike metadataRecheck's work_queue dedupKey, there's no "tried
// once, give up" marker here because lyrics can also arrive later from a tag
// re-scan or an on-demand getLyrics fetch, and any of those already clear the
// WHERE condition for us.

import { fetchLrcSidecar, fetchSidecarRich } from "./lrcSidecar";
import { getFeatureString } from "./features";
import { ensureRichLyricsColumn } from "./schema_patch";
import { serializeRich } from "./richLyrics";

const LAST_RUN_KEY = "cron:last_lrc_backfill_ts";
// Kept well under the Workers subrequest ceiling — each candidate costs one
// R2/WebDAV GET (fetchLrcSidecar) plus a conditional D1 UPDATE. Mirrors the
// order of magnitude of scan.ts's MAX_DAV_REQUESTS.
const BATCH_LIMIT = 40;

interface Candidate {
  master_id: string;
  storage_uri: string;
}

export interface LrcBackfillResult {
  candidates: number;
  filled: number;
}

// Core selection + fill, no cadence gate — shared by the cron tick
// (maybeRunLrcBackfill, below) and the admin "run now" endpoint
// (POST /edgesonic/work/backfillLrcNow) so both paths behave identically.
//
// 0259 — also back-fills `lyrics_rich` from sibling .ttml/.krc/enhanced .lrc
// sidecars. Candidates are songs that still lack EITHER the line-level LRC
// OR the rich payload, so a pre-existing library that pre-dates 0259 gets
// the new column populated without a forced full re-scan.
export async function runLrcBackfill(db: D1Database, env: Env): Promise<LrcBackfillResult> {
  await ensureRichLyricsColumn(env);
  const candidates = (await db.prepare(
    `SELECT sm.id AS master_id, si.storage_uri AS storage_uri
       FROM song_masters sm
       JOIN song_instances si ON si.master_id = sm.id
      WHERE (sm.lyrics IS NULL OR sm.lyrics = ''
             OR sm.lyrics_rich IS NULL OR sm.lyrics_rich = '')
        AND si.missing = 0
        AND si.source_type = 'original'
        AND (si.storage_uri LIKE 'r2://%' OR si.storage_uri LIKE 'webdav://%')
      GROUP BY sm.id
      LIMIT ?`,
  ).bind(BATCH_LIMIT).all<Candidate>()).results;

  let filled = 0;
  for (const cand of candidates) {
    try {
      const lrc = await fetchLrcSidecar(env, cand.storage_uri);
      if (lrc) {
        // Conditional UPDATE mirrors importLrcOnScan — avoids racing a
        // concurrent tag-write/getLyrics fetch that may have already
        // populated the column between SELECT and here.
        const result = await db.prepare(
          `UPDATE song_masters SET lyrics = ?, updated_at = ?
            WHERE id = ? AND (lyrics IS NULL OR lyrics = '')`,
        ).bind(lrc, Math.floor(Date.now() / 1000), cand.master_id).run();
        if (result.meta.changes > 0) filled++;
      }
      // 0259 — also fetch a rich sidecar (.ttml / .krc / enhanced .lrc)
      // when one is present. Independent of the LRC result above — a
      // track can have both a .lrc and a .ttml sidecar.
      const rich = await fetchSidecarRich(env, cand.storage_uri);
      if (rich) {
        await db.prepare(
          `UPDATE song_masters SET lyrics_rich = ?, updated_at = ?
            WHERE id = ? AND (lyrics_rich IS NULL OR lyrics_rich = '')`,
        ).bind(serializeRich(rich), Math.floor(Date.now() / 1000), cand.master_id).run();
      }
    } catch {
      // Best-effort — a transient R2/WebDAV/D1 hiccup on one track must not
      // abort the rest of the batch.
    }
  }

  return { candidates: candidates.length, filled };
}

export async function maybeRunLrcBackfill(env: Env, _ctx: ExecutionContext): Promise<void> {
  const raw = await getFeatureString(env, "lrc_backfill_interval_hours", "24");
  const hours = Math.max(0, Math.floor(Number(raw) || 0));
  if (hours === 0) return; // disabled

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  if (hours > 1) {
    const row = await db.prepare("SELECT value FROM kv_store WHERE key = ?")
      .bind(LAST_RUN_KEY)
      .first<{ value: string }>();
    const last = row ? Number(row.value) : 0;
    if (Number.isFinite(last) && last > 0 && now - last < hours * 3600) {
      return; // not yet
    }
  }
  // Stamp BEFORE running — same reasoning as scheduledScan.ts/metadataRecheck.ts:
  // a failure mid-batch shouldn't turn into an every-tick retry storm.
  await db.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(LAST_RUN_KEY, String(now), now).run();

  await runLrcBackfill(db, env);
}
