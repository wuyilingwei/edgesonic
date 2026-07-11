//
// wrangler.toml fixes the cron to `0 */1 * * *` (every hour, shared with
// 046's podcast refresh). To support cadences other than hourly we layer a
// soft scheduler on top: each tick this helper consults
// `feature_strings.scan_interval_hours` and `KV.cron:last_scan_ts` to decide
// whether enough wall-clock time has elapsed since the previous run.
//
// Semantics:
//   scan_interval_hours = 0  → disabled, return immediately
//   scan_interval_hours = 1  → run every tick (still writes last_scan_ts so
//                                ops can monitor cadence)
//  scan_interval_hours = N>1 → only run when now - last_scan_ts >= N * 3600
//
// Each run dispatches one scan_jobs row per enabled WebDAV source, then fires
// asyncScanSource via ctx.waitUntil so individual sources don't block each
// other. Per-source errors are recorded into scan_jobs.error_message (not
// thrown) so a broken iCloud feed doesn't poison the rest.

import { asyncScanSource } from "../endpoints/storage/scan";
import { createQueries } from "../db/queries";
import { getFeatureString } from "./features";

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
  // 089 S2 — 'library' (default) | 'sync_only' (scan but skip DB inserts)
  mode?: string | null;
}

const LAST_RUN_KEY = "cron:last_scan_ts";

export async function maybeRunScheduledScan(env: Env, ctx: ExecutionContext): Promise<void> {
  // ------------------------------------------------------------------
  // Cadence gate
  // ------------------------------------------------------------------
  const raw = await getFeatureString(env, "scan_interval_hours", "1");
  const hours = Math.max(0, Math.floor(Number(raw) || 0));
  if (hours === 0) return;                                  // disabled

  const now = Math.floor(Date.now() / 1000);
  if (hours > 1) {
    const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?")
      .bind(LAST_RUN_KEY)
      .first<{ value: string }>();
    const last = row ? Number(row.value) : 0;
    if (Number.isFinite(last) && last > 0 && now - last < hours * 3600) {
      return;                                               // not yet
    }
  }
  // Stamp BEFORE dispatching so failures don't cause a runaway every-tick
  // retry. Bigger cadence will simply wait another hour.
  await env.DB.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(LAST_RUN_KEY, String(now), now).run();

  // ------------------------------------------------------------------
  // Enumerate enabled WebDAV sources
  // ------------------------------------------------------------------
  const db = env.DB;
  const sources = (await db.prepare(
    `SELECT id, base_url, username, password, root_path, mode FROM storage_sources
     WHERE type = 'webdav' AND enabled = 1`,
  ).all<SourceRow>()).results;
  if (!sources.length) return;

  // ------------------------------------------------------------------
  // Read scan_etag_check once for this tick so all dispatched jobs share
  // a coherent setting snapshot.
  // ------------------------------------------------------------------
  const etagCheck = (await getFeatureString(env, "scan_etag_check", "1")) !== "0";

  const queries = createQueries(db);
  for (const src of sources) {
    const jobId = "sj-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    try {
      await queries.insertScanJob({ id: jobId, sourceId: src.id });
    } catch (e) {
      console.error("scheduled scan: insertScanJob failed", e);
      continue;
    }
    // ctx.waitUntil so per-source progress can finish past the immediate
    // return value of scheduled().
    ctx.waitUntil(
      asyncScanSource(db, src, jobId, { etagCheck, env }).catch((e) => {
        console.error(`scheduled scan source=${src.id} failed:`, e);
      }),
    );
  }
}
