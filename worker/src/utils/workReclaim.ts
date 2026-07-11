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
// A browser node that grabbed a task and then went offline (tab close, network
// drop, OS sleep) leaves the row in status='claimed' with a heartbeat_at that
// keeps ageing. This sweep, triggered from the scheduled handler in
// index.ts, returns those rows to 'queued' so another worker can pick them up
// — unless they've already failed too many times, in which case they go to
// 'failed' terminal state with an explanatory error_message.
//
// Two thresholds drive the decision:
//  worker_claim_ttl_seconds — heartbeat age beyond which a claim is "stale"
//                            short enough that a closed tab unblocks the
//                            queue within a minute)
//   max_attempts (per row) — work_queue.max_attempts (default 3)

import { getFeatureString } from "./features";

export interface ReclaimReport {
  scanned: number;
  reQueued: number;
  failed: number;
}

export async function reclaimStaleWork(env: Env): Promise<ReclaimReport> {
  const ttl = parseInt(await getFeatureString(env, "worker_claim_ttl_seconds", "60"), 10);
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 60;
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;

  // Pull every stale claim in one shot. The partial index idx_work_claimed
  // makes this O(stale) even with a giant historical queue.
  const stale = (await env.DB.prepare(
    `SELECT id, attempts, max_attempts
     FROM work_queue
     WHERE status = 'claimed' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
  ).bind(cutoff).all<{ id: string; attempts: number; max_attempts: number }>()).results;

  const report: ReclaimReport = { scanned: stale.length, reQueued: 0, failed: 0 };
  if (stale.length === 0) return report;

  // Batch updates in two buckets: rows still under the retry budget go back to
  // 'queued', rows that ran out of attempts go to terminal 'failed'. We keep
  // attempts as-is — the failed claim already counted +1 when /work/poll ran.
  const reQueueStmts: D1PreparedStatement[] = [];
  const failStmts: D1PreparedStatement[] = [];
  for (const row of stale) {
    if (row.attempts >= row.max_attempts) {
      report.failed++;
      failStmts.push(
        env.DB.prepare(
          `UPDATE work_queue
           SET status = 'failed',
               error_message = COALESCE(error_message, 'stale claim: max attempts exceeded'),
               claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
           WHERE id = ?`,
        ).bind(row.id),
      );
    } else {
      report.reQueued++;
      reQueueStmts.push(
        env.DB.prepare(
          `UPDATE work_queue
           SET status = 'queued',
               error_message = COALESCE(error_message, 'stale claim re-queued'),
               claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
           WHERE id = ?`,
        ).bind(row.id),
      );
    }
  }
  // D1 batch caps at ~100 statements; we chunk for safety.
  for (let i = 0; i < reQueueStmts.length; i += 80) {
    await env.DB.batch(reQueueStmts.slice(i, i + 80));
  }
  for (let i = 0; i < failStmts.length; i += 80) {
    await env.DB.batch(failStmts.slice(i, i + 80));
  }
  return report;
}
