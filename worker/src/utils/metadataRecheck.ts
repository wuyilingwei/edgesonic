// ---------------------------------------------------------------------------
// Two problems this closes:
//
// A) "Other file formats should try to be compatible too" — the worker's
//    embedded tag parser (utils/tags.ts) only recognizes MP3 (ID3v2),
//    FLAC, and WAV. Anything else (M4A/OGG/Opus/WMA/APE/AIFF/ALAC/DSF)
//    returns null from parseTags(), and endpoints/tag/read.ts permanently
//    marks the row tag_scanned=2 ("leave scanned = 2 so we don't loop
//    forever on broken files") — it never gets a second chance. We do NOT
//    reimplement those container formats server-side (music-metadata
//    already parses them robustly in the browser worker pool, 052a/052b);
//    instead we hand the row to that pool once.
//
// B) "Auto-dispatch cases missing lyrics etc. but not missing cover art"
//    songs that were already successfully scanned (tag_scanned=1) and
//    whose album already has a resolved cover (proof the pipeline mostly
//    worked) but are still missing lyrics/disc — likely because they were
//    scanned before 109 wired up lyrics/disc extraction. These get one
//    more browser-pool pass so the now-fixed extraction can backfill them.
//
// C) "WAV duration reads as ~3 seconds" — 111 fixed the root cause (a
//    Range-truncated 512KB buffer made music-metadata's WaveParser clamp
//    the audio "data" chunk length to whatever fit in the slice, instead of
//    the file's real length), but library rows scanned BEFORE that fix
//    already have the wrong (tiny) duration baked into D1. A WAV several
//    MB in size that "lasts" under 10 real seconds is implausible at any
//    realistic bitrate — flag those for one more pass so the fixed code
//    recomputes them.
//
// All three dispatch the SAME 'metadata' task type via dispatchWorkBatch.
// A/B use dedupKey namespace "recheck:<instanceId>"; C uses a separate
// "recheck-dur:<instanceId>" namespace. 076's INSERT OR IGNORE semantics mean
// a given dedupKey is only ever dispatched once (the work_queue row is never
// deleted) — reusing scan.ts's plain "<instanceId>" key would make
// already-scanned instances undispatchable here, and folding C into the same
// "recheck:" namespace as A/B would mean an instance already re-checked once
// under A/B (before 111 existed) could never get the C duration fix either.
// Separate namespaces keep each family of fix independently retriable exactly
// once per instance — a failed/no-op result is never retried forever.

import { dispatchWorkBatch, type DispatchInput } from "../endpoints/edgesonic/work";
import { getFeatureString } from "./features";

const LAST_RUN_KEY = "cron:last_metadata_recheck_ts";

// Cap per run so a huge library doesn't try to queue thousands of rows (and
// blow the D1 batch/CPU budget) the first time this is enabled.
const BATCH_LIMIT = 300;

interface CandidateRow {
  id: string;
  storage_uri: string;
  suffix: string | null;
  size: number | null;
}

export interface RecheckResult {
  unsupportedFormat: number;
  lyricsOrDiscIncomplete: number;
  implausibleWavDuration: number;
  dispatched: number;
}

// Wire shape helper — matches scan.ts's dispatchWorkBatch payload exactly
// (instanceId/sourceUri/suffix/size) so the main-thread workerPool.ts can
// resolve streamUrl the same way it does for a fresh scan dispatch.
function toDispatchInputs(rows: CandidateRow[], dedupPrefix: string): DispatchInput[] {
  return rows.map((row) => ({
    taskType: "metadata",
    payload: {
      instanceId: row.id,
      sourceUri: row.storage_uri,
      suffix: row.suffix,
      size: row.size,
    },
    requiredCaps: ["music-metadata"],
    priority: 5,
    dedupKey: `${dedupPrefix}:${row.id}`,
  }));
}

// Core selection + dispatch, no cadence gate — shared by the cron tick
// (maybeRunMetadataRecheck, below) and the admin "run now" endpoint
// (POST /edgesonic/work/recheckMetadataNow) so both paths select and dedupe
// candidates identically.
export async function runMetadataRecheck(db: D1Database): Promise<RecheckResult> {
  // A) worker-side parser gave up (unsupported format or corrupt file).
  const unsupported = (await db.prepare(
    `SELECT id, storage_uri, suffix, size FROM song_instances
     WHERE missing = 0 AND tag_scanned = 2
     LIMIT ?`,
  ).bind(BATCH_LIMIT).all<CandidateRow>()).results;

  // B) already scanned, but the album has a cover and lyrics/disc are still
  // empty — worth a second browser-pool pass now that 109 extracts them.
  const remainingAfterA = Math.max(0, BATCH_LIMIT - unsupported.length);
  const incomplete = remainingAfterA > 0
    ? (await db.prepare(
        `SELECT si.id, si.storage_uri, si.suffix, si.size FROM song_instances si
         JOIN song_masters sm ON sm.id = si.master_id
         JOIN albums al ON al.id = sm.album_id
         WHERE si.missing = 0 AND si.tag_scanned = 1
           AND al.cover_r2_key IS NOT NULL AND al.cover_r2_key != ''
           AND (sm.lyrics IS NULL OR sm.lyrics = '' OR sm.disc IS NULL)
         LIMIT ?`,
      ).bind(remainingAfterA).all<CandidateRow>()).results
    : [];

  // implausible at any realistic bitrate (a 5MB CD-quality WAV alone decodes
  // to ~28s minimum) and is almost certainly a pre-111 truncated-buffer scan.
  const remainingAfterB = Math.max(0, BATCH_LIMIT - unsupported.length - incomplete.length);
  const badWavDuration = remainingAfterB > 0
    ? (await db.prepare(
        `SELECT si.id, si.storage_uri, si.suffix, si.size FROM song_instances si
         JOIN song_masters sm ON sm.id = si.master_id
         WHERE si.missing = 0 AND si.tag_scanned = 1 AND si.suffix = 'wav'
           AND si.size > 5242880
           AND sm.duration IS NOT NULL AND sm.duration > 0 AND sm.duration < 10
         LIMIT ?`,
      ).bind(remainingAfterB).all<CandidateRow>()).results
    : [];

  const result: RecheckResult = {
    unsupportedFormat: unsupported.length,
    lyricsOrDiscIncomplete: incomplete.length,
    implausibleWavDuration: badWavDuration.length,
    dispatched: unsupported.length + incomplete.length + badWavDuration.length,
  };
  if (result.dispatched === 0) return result;

  await dispatchWorkBatch(db, [
    ...toDispatchInputs(unsupported, "recheck"),
    ...toDispatchInputs(incomplete, "recheck"),
    ...toDispatchInputs(badWavDuration, "recheck-dur"),
  ]);
  return result;
}

export async function maybeRunMetadataRecheck(env: Env, _ctx: ExecutionContext): Promise<void> {
  const raw = await getFeatureString(env, "metadata_recheck_interval_hours", "24");
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
  // Stamp BEFORE dispatching — same reasoning as scheduledScan.ts: a
  // dispatch failure shouldn't turn into an every-tick retry storm.
  await db.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(LAST_RUN_KEY, String(now), now).run();

  await runMetadataRecheck(db);
}
