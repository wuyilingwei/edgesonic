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
// Each run dispatches one scan_jobs row per enabled WebDAV/S3/R2 source, then
// fires the matching asyncScan*Source via ctx.waitUntil so individual sources
// don't block each other. Per-source errors are recorded into
// scan_jobs.error_message (not thrown) so a broken iCloud feed (or a stalled
// R2 listing) doesn't poison the rest.

import { asyncScanSource, asyncScanS3Source, asyncScanR2Source } from "../endpoints/storage/scan";
import { synthesizeR2Row } from "../endpoints/storage/sources";
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

interface S3SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
  region: string | null;
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
  // Enumerate enabled sources across all three scan-capable types. R2 gets
  // the same synthesize-if-missing treatment as the manual scan/start
  // handler (endpoints/storage/scan.ts) — an admin who never explicitly
  // edited the built-in R2 source still gets it auto-scanned, and scan_jobs
  // needs a real storage_sources row to satisfy its FK before we can insert.
  // ------------------------------------------------------------------
  const db = env.DB;
  const davSources = (await db.prepare(
    `SELECT id, base_url, username, password, root_path, mode FROM storage_sources
     WHERE type = 'webdav' AND enabled = 1`,
  ).all<SourceRow>()).results;
  const s3Sources = (await db.prepare(
    `SELECT id, base_url, username, password, root_path, region, mode FROM storage_sources
     WHERE type = 's3' AND enabled = 1`,
  ).all<S3SourceRow>()).results;
  const r2Real = (await db.prepare(
    `SELECT id, mode FROM storage_sources WHERE type = 'r2' AND enabled = 1`,
  ).all<{ id: string; mode: string | null }>()).results;
  const r2Sources: Array<{ id: string; mode: string | null }> = r2Real.length > 0
    ? r2Real
    : [{ id: synthesizeR2Row().id, mode: synthesizeR2Row().mode }];
  if (r2Real.length === 0) {
    const now2 = Math.floor(Date.now() / 1000);
    const defaults = synthesizeR2Row();
    await db.prepare(
      `INSERT INTO storage_sources (id, type, name, base_url, root_path, mode, enabled, created_at, updated_at)
       VALUES (?, 'r2', ?, '', '', ?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(defaults.id, defaults.name, defaults.mode, now2, now2).run();
  }

  if (!davSources.length && !s3Sources.length && !r2Sources.length) return;

  // ------------------------------------------------------------------
  // Read scan_etag_check once for this tick so all dispatched jobs share
  // a coherent setting snapshot.
  // ------------------------------------------------------------------
  const etagCheck = (await getFeatureString(env, "scan_etag_check", "1")) !== "0";

  const queries = createQueries(db);
  for (const src of davSources) {
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
  for (const src of s3Sources) {
    const jobId = "sj-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    try {
      await queries.insertScanJob({ id: jobId, sourceId: src.id });
    } catch (e) {
      console.error("scheduled scan: insertScanJob failed (s3)", e);
      continue;
    }
    ctx.waitUntil(
      asyncScanS3Source(env, db, src, jobId, { etagCheck }).catch((e) => {
        console.error(`scheduled scan source=${src.id} (s3) failed:`, e);
      }),
    );
  }
  for (const src of r2Sources) {
    const jobId = "sj-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    try {
      await queries.insertScanJob({ id: jobId, sourceId: src.id });
    } catch (e) {
      console.error("scheduled scan: insertScanJob failed (r2)", e);
      continue;
    }
    ctx.waitUntil(
      asyncScanR2Source(env, db, src, jobId, { etagCheck }).catch((e) => {
        console.error(`scheduled scan source=${src.id} (r2) failed:`, e);
      }),
    );
  }
}
