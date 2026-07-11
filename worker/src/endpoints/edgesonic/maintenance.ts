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
// These are one-shot admin tools for tidying up the database state, not part
// of any user-facing protocol. Each endpoint is super-admin only (level >= 3)
// and safe to re-run (idempotent / "no-op when nothing to do").
//
// First endpoint: cleanupDuplicateCovers.
//  Background: Before 076 the getCoverArt fallback path (resolveAlbumCover)
//  would write the same parent-directory cover.jpg to a distinct R2 key per
//  album, so a folder hosting 25 albums ended up with 25 R2 keys whose
//  *contents* were identical (one anime character shown for every album).
//  076 removed the fallback, but the 25 historical keys are still bound to
//  their albums in D1. This endpoint releases all but one binding per
//  duplicate key, letting each freed album re-resolve its own cover on the
//  next /rest/getCoverArt call (which now correctly 404s if no per-album
//  cover exists, prompting <img onerror> to fall back to the UI placeholder
//  — the desired behaviour).
//
// We do NOT delete the R2 objects: the survivor row in each group still
//  needs the bytes. R2 lifecycle / orphan sweep is a separate concern.

import { Hono } from "hono";
import type { User } from "../../types/entities";
import { getFeatureString } from "../../utils/features";
import { permissionMiddleware } from "../../auth";

export const maintenanceRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// hardcoded level check was replaced by permissionMiddleware against three
// new permission rows (maintenance_cleanup / maintenance_reclaim /
// maintenance_reset, see migration 0024) so operators can delegate the
// tooling to L2 admins via the Permissions UI without a code change.

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/cleanupDuplicateCovers
// ---------------------------------------------------------------------------
// Response: { ok: true, groups, cleared }
//  - groups: number of distinct cover_r2_key values that had >1 album
//  - cleared: number of albums whose cover_r2_key was set to NULL
//
// Algorithm:
//  1. SELECT cover_r2_key, COUNT(*) FROM albums GROUP BY ... HAVING n > 1
//  2. For each duplicated key, SELECT ids ORDER BY id ASC.
//    Survivor = ids[0]; the rest get cover_r2_key=NULL.
//
// Why "id ASC" as the survivor rule? Stable + deterministic + matches the
// `id` we generate during scan (which itself is created-order-ish), so the
// album that was created first keeps the cover binding. A future variant
// could pick by song_count or updated_at, but the simplest tie-break is also
// the easiest to reason about during recovery.
maintenanceRoutes.post("/maintenance/cleanupDuplicateCovers",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;

  // Aggregate the duplicate cover_r2_key values. We deliberately skip rows
  // where cover_r2_key IS NULL — those are albums without a cover at all and
  // they're not the problem.
  const dupes = (await env.DB.prepare(
    `SELECT cover_r2_key AS cover_r2_key, COUNT(*) AS n
     FROM albums
     WHERE cover_r2_key IS NOT NULL
     GROUP BY cover_r2_key
     HAVING n > 1
     ORDER BY n DESC`,
  ).all<{ cover_r2_key: string; n: number }>()).results;

  if (dupes.length === 0) {
    return c.json({ ok: true, groups: 0, cleared: 0 });
  }

  let cleared = 0;
  for (const dup of dupes) {
    // Pull the album ids that share this cover key, oldest first. We can't
    // use GROUP_CONCAT here because we need ORDER BY id ASC to pick a stable
    // survivor; a separate SELECT is the cheapest correct form.
    const ids = (await env.DB.prepare(
      `SELECT id
       FROM albums
       WHERE cover_r2_key = ?
       ORDER BY id ASC`,
    ).bind(dup.cover_r2_key).all<{ id: string }>()).results;

    // Defensive: a race could have rewritten the binding between the two
    // queries. If only one row remains, skip — nothing duplicated anymore.
    if (ids.length < 2) continue;

    // ids[0] is the survivor; release the rest. We could do an `IN (?,?,?)`
    // but D1's bind parameter limit (100) plus the fact that we'd need to
    // build the placeholder list dynamically makes a per-row UPDATE simpler
    // and not much slower (each group is ~25 rows max per the 076 finding).
    for (let i = 1; i < ids.length; i++) {
      const result = await env.DB.prepare(
        `UPDATE albums
         SET cover_r2_key = NULL,
             updated_at = unixepoch()
         WHERE id = ? AND cover_r2_key = ?`,
      ).bind(ids[i].id, dup.cover_r2_key).run();
      // Only count rows we actually changed — if another process raced us
      // (e.g. an admin manually re-bound the cover during the sweep) the
      // WHERE-constrained UPDATE turns into a no-op.
      if (result.meta.changes > 0) cleared++;
    }
  }

  return c.json({ ok: true, groups: dupes.length, cleared });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/reclaimStaleWork
// ---------------------------------------------------------------------------
// scheduled handler. Useful when the CF Worker has no cron schedules (the
// 067 dynamic-cron path was never run with ensureDefaultCron after a deploy)
// and browser workers have left rows stuck in 'claimed' with stale heartbeats.
//
// Response: { ok, reclaimed, requeued, failed, items: [{ id, status, attempts }] }
//  - reclaimed: total rows mutated (requeued + failed)
//  - requeued: rows whose attempts<max_attempts → status='queued'
//   - failed:  rows whose attempts>=max_attempts → status='failed' terminal
//   - items:   the per-row breakdown (capped naturally by the stale set)
//
// We use a single UPDATE … RETURNING so the read and the write happen against
// a consistent snapshot — without RETURNING we'd risk reclaiming rows that
// changed status between the SELECT and the UPDATE.
maintenanceRoutes.post("/maintenance/reclaimStaleWork",
  permissionMiddleware("maintenance_reclaim"),
  async (c) => {
  const env = c.env as Env;

  // Feature key was registered in 052a (default 60s) — the same one workReclaim
  // reads, so the manual button reuses the operator's tuning.
  const raw = await getFeatureString(env, "worker_claim_ttl_seconds", "60");
  const parsed = parseInt(raw, 10);
  const ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;

  // Mirror workReclaim's branching: bucket by attempts vs max_attempts. The
  // CASE expressions on status and error_message make the two paths atomic in
  // one statement, and RETURNING surfaces the post-update row so the response
  // can show the operator exactly what happened.
  //
 // We keep the error_message wording aligned with workReclaim.ts so the
  // /work/status feed reads identically for cron-driven and manually-driven
  // reclaims (an operator inspecting failed rows shouldn't have to guess
  // whether the sweep was automatic).
  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET status = CASE
                    WHEN attempts >= max_attempts THEN 'failed'
                    ELSE 'queued'
                  END,
         claimed_by = NULL,
         claimed_at = NULL,
         heartbeat_at = NULL,
         error_message = CASE
                           WHEN attempts >= max_attempts
                             THEN COALESCE(error_message, 'stale claim: max attempts exceeded')
                           ELSE COALESCE(error_message, 'stale claim re-queued')
                         END
     WHERE status = 'claimed'
       AND heartbeat_at IS NOT NULL
       AND heartbeat_at < unixepoch() - ?
     RETURNING id, status, attempts`,
  ).bind(ttl).all<{ id: string; status: string; attempts: number }>();

  const items = result.results || [];
  let requeued = 0;
  let failed = 0;
  for (const row of items) {
    if (row.status === "queued") requeued++;
    else if (row.status === "failed") failed++;
  }
  return c.json({
    ok: true,
    reclaimed: items.length,
    requeued,
    failed,
    ttlSeconds: ttl,
    items,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/resetFailedWork
// ---------------------------------------------------------------------------
//  When a browser worker shipped a buggy bundle, every task it picked up
//  would burn through attempts (default max=3) and end up at status='failed'.
//  Subsequent scans INSERT OR IGNORE the same deterministic id, so the
//  failed row sticks around forever and no fresh worker ever gets a shot at
//  it. The legitimate (now updated) bundle therefore can't recover the
//  instance metadata until somebody manually flips the failed rows back to
//  queued. This endpoint is that flip.
//
// Query: task_type=<optional> — filter the reset to a single task type. Useful
//  for "I only want metadata tasks to retry, leave the scan failures alone".
// Response: { ok: true, reset, taskType? }
//   - reset:  number of rows whose status moved 'failed' → 'queued'
//  - taskType: echoes the filter when given (helpful in operator audit log)
//
// Why the wholesale reset (attempts=0, clear claimed_* / error_message)?
//  - attempts=0: a fresh bundle deserves a clean budget; otherwise the very
//   first hiccup re-fails it.
//  - claimed_by/claimed_at/heartbeat_at: failed rows shouldn't carry
//   stale-claim residue. Leaving them set would make a future workReclaim
//   sweep treat the row as "claimed but stale" and try to flip it back to
//   failed again — clearing is safer.
//  - error_message=NULL: the previous error doesn't apply to the retry; the
//   UI shows it as a fresh queued row.
//
// Idempotent: re-running with zero failed rows just returns reset=0.
maintenanceRoutes.post("/maintenance/resetFailedWork",
  permissionMiddleware("maintenance_reset"),
  async (c) => {
  const env = c.env as Env;

  // Optional filter — drop the param entirely if absent so the SQL stays
  // bind-arity-clean (avoids a "?" with no matching bind).
  const onlyTaskType = c.req.query("task_type");
  const where = onlyTaskType
    ? "status='failed' AND task_type=?"
    : "status='failed'";
  const stmt = env.DB.prepare(
    `UPDATE work_queue
     SET status='queued',
         attempts=0,
         error_message=NULL,
         claimed_by=NULL,
         claimed_at=NULL,
         heartbeat_at=NULL
     WHERE ${where}`,
  );
  const result = onlyTaskType
    ? await stmt.bind(onlyTaskType).run()
    : await stmt.run();

  return c.json({
    ok: true,
    reset: result.meta.changes,
    ...(onlyTaskType ? { taskType: onlyTaskType } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/maintenance/webdavThroughput?id=<sm-...>&bytes=N
// ---------------------------------------------------------------------------
// leg in isolation. Fetches up to N bytes (default 4 MiB, max 32 MiB) of the
// song's webdav instance inside the Worker and discards them.
//
// Interpreting the result against what the browser observes on /rest/stream:
//   - originMBps low here too          → the origin / CF-to-origin route is
//                                        the bottleneck (hot cache is the fix)
//  - originMBps high, browser still slow → the sub-request bandwidth pool is
//                                        throttling the proxied stream
//                                        (hot cache / presign is the fix)
maintenanceRoutes.get("/maintenance/webdavThroughput",
  permissionMiddleware("maintenance_cleanup"),
  async (c) => {
  const env = c.env as Env;
  const id = c.req.query("id");
  if (!id) return c.json({ ok: false, error: "Missing id (song master id)" }, 400);
  const bytesParam = parseInt(c.req.query("bytes") || "0", 10) || 4 * 1024 * 1024;
  const bytes = Math.min(Math.max(bytesParam, 64 * 1024), 32 * 1024 * 1024);

  const inst = await env.DB.prepare(
    `SELECT storage_uri FROM song_instances
     WHERE master_id = ? AND storage_uri LIKE 'webdav://%' AND missing = 0
     LIMIT 1`,
  ).bind(id).first<{ storage_uri: string }>();
  if (!inst) return c.json({ ok: false, error: "No webdav instance for this id" }, 404);

  const { createWebDAVAdapter } = await import("../../adapters/webdav");
  const t0 = Date.now();
  const resp = await createWebDAVAdapter(env.DB, env).stream(inst.storage_uri, `bytes=0-${bytes - 1}`);
  if (!resp.body || resp.statusCode >= 400) {
    return c.json({ ok: false, error: `origin responded ${resp.statusCode}` }, 502);
  }
  const reader = resp.body.getReader();
  let received = 0;
  let ttfbMs: number | null = null;
  while (received < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - t0;
    received += value.length;
  }
  await reader.cancel().catch(() => {});
  const elapsedMs = Date.now() - t0;
  const transferMs = Math.max(elapsedMs - (ttfbMs ?? 0), 1);

  return c.json({
    ok: true,
    uri: inst.storage_uri.replace(/^(webdav:\/\/[^/]+).*/, "$1/…"),
    requestedBytes: bytes,
    receivedBytes: received,
    ttfbMs,
    elapsedMs,
    originMBps: Number((received / 1024 / 1024 / (transferMs / 1000)).toFixed(2)),
  });
});
