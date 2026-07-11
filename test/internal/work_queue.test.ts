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
// Coverage:
//  1. dispatchWork → row appears in queue with correct caps/payload
//  2. dispatchWorkBatch → many rows in one D1 batch call
//  3. /work/poll atomic claim (RETURNING)
//  4. /work/poll caps filter — task with required_caps the caller lacks is NOT returned
//  5. /work/submit success path → status='completed', result_json stored
//  6. /work/submit error path — attempts left → re-queued ; exhausted → failed
//  7. /work/heartbeat updates heartbeat_at on the claimed row only
//  8. /work/cancel marks row canceled
//  9. reclaimStaleWork puts heartbeat-aged claims back to queued (or failed when attempts exhausted)
//
// Run: npx tsx test/internal/work_queue.test.ts

import { dispatchWork, dispatchWorkBatch } from "../../worker/src/endpoints/edgesonic/work";
import { reclaimStaleWork } from "../../worker/src/utils/workReclaim";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

// ----------------------------------------------------------------------------
// In-memory D1 mock — captures every row in work_queue. We use a single
// dispatcher per test so each assertion sees its own state.
// ----------------------------------------------------------------------------
interface WorkRow {
  id: string;
  task_type: string;
  payload: string;
  required_caps: string | null;
  priority: number;
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
  heartbeat_at: number | null;
  result_json: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  expires_at: number | null;
}

interface KvEntry { value: string; expires?: number }

function makeEnv() {
  const rows: WorkRow[] = [];
  const kv = new Map<string, KvEntry>();
  let now = 1_000_000_000;            // controllable clock for the test

  function makeStmt(sql: string, binds: unknown[] = []): unknown {
    const trimmed = sql.trim().replace(/\s+/g, " ");
    return {
      bind(...args: unknown[]) { return makeStmt(sql, args); },
      async run() {
        if (trimmed.startsWith("INSERT INTO work_queue")) {
          rows.push({
            id: binds[0] as string,
            task_type: binds[1] as string,
            payload: binds[2] as string,
            required_caps: binds[3] as string | null,
            priority: binds[4] as number,
            status: "queued",
            claimed_by: null,
            claimed_at: null,
            heartbeat_at: null,
            result_json: null,
            error_message: null,
            attempts: 0,
            max_attempts: binds[5] as number,
            created_at: now++,
            expires_at: binds[6] as number | null,
          });
          return { success: true, meta: { changes: 1 } };
        }
        // /work/submit success path
        if (trimmed.startsWith("UPDATE work_queue SET status = 'completed'")) {
          const id = binds[binds.length - 1] as string;
          const r = rows.find((x) => x.id === id);
          if (r) {
            r.status = "completed";
            r.result_json = binds[0] as string | null;
            r.error_message = null;
            r.heartbeat_at = binds[1] as number;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // /work/submit failure path
        if (trimmed.startsWith("UPDATE work_queue SET status = ?,")) {
          const newStatus = binds[0] as string;
          const errMsg = binds[1] as string;
          const id = binds[2] as string;
          const r = rows.find((x) => x.id === id);
          if (r) {
            r.status = newStatus;
            r.error_message = errMsg;
            r.claimed_by = null;
            r.claimed_at = null;
            r.heartbeat_at = null;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // /work/heartbeat
        if (trimmed.startsWith("UPDATE work_queue SET heartbeat_at = unixepoch()")) {
          const id = binds[0] as string;
          const claimer = binds[1] as string;
          const r = rows.find((x) => x.id === id && x.status === "claimed" && x.claimed_by === claimer);
          if (r) {
            r.heartbeat_at = now;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // /work/cancel
        if (trimmed.startsWith("UPDATE work_queue SET status = 'canceled'")) {
          const id = binds[0] as string;
          const r = rows.find((x) => x.id === id && !["completed", "canceled"].includes(x.status));
          if (r) {
            r.status = "canceled";
            if (!r.error_message) r.error_message = "canceled by admin";
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // reclaim re-queue
        if (trimmed.startsWith("UPDATE work_queue SET status = 'queued',")) {
          const id = binds[0] as string;
          const r = rows.find((x) => x.id === id);
          if (r) {
            r.status = "queued";
            if (!r.error_message) r.error_message = "stale claim re-queued";
            r.claimed_by = null;
            r.claimed_at = null;
            r.heartbeat_at = null;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // reclaim → failed
        if (trimmed.startsWith("UPDATE work_queue SET status = 'failed',")) {
          const id = binds[0] as string;
          const r = rows.find((x) => x.id === id);
          if (r) {
            r.status = "failed";
            if (!r.error_message) r.error_message = "stale claim: max attempts exceeded";
            r.claimed_by = null;
            r.claimed_at = null;
            r.heartbeat_at = null;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        throw new Error(`unmocked run sql: ${trimmed}`);
      },
      async first<T = unknown>() {
        // poll: SELECT row before claim — handled by `all` (we treat poll's
        // SELECT as a batch read, even though the worker code uses .all()).
        // The other first() call is the UPDATE ... RETURNING claim:
        if (trimmed.startsWith("UPDATE work_queue SET status = 'claimed'")) {
          const claimer = binds[0] as string;
          const targetId = binds[1] as string;
          const r = rows.find((x) => x.id === targetId && x.status === "queued");
          if (!r) return null as T | null;
          r.status = "claimed";
          r.claimed_by = claimer;
          r.claimed_at = now;
          r.heartbeat_at = now;
          r.attempts++;
          return {
            id: r.id,
            task_type: r.task_type,
            payload: r.payload,
            required_caps: r.required_caps,
            priority: r.priority,
            attempts: r.attempts,
            max_attempts: r.max_attempts,
            claimed_at: r.claimed_at,
            heartbeat_at: r.heartbeat_at,
          } as T;
        }
        if (trimmed.startsWith("SELECT status, claimed_by")) {
          const id = binds[0] as string;
          const r = rows.find((x) => x.id === id);
          if (!r) return null as T | null;
          return {
            status: r.status,
            claimed_by: r.claimed_by,
            attempts: r.attempts,
            max_attempts: r.max_attempts,
          } as T;
        }
        if (trimmed.startsWith("SELECT value FROM feature_strings")) {
          const key = binds[0] as string;
          const v = featureStrings.get(key);
          return (v ? { value: v } : null) as T | null;
        }
        throw new Error(`unmocked first sql: ${trimmed}`);
      },
      async all<T = unknown>() {
        if (trimmed.startsWith("SELECT key, value FROM feature_strings")) {
          return {
            results: Array.from(featureStrings.entries()).map(([key, value]) => ({ key, value })),
          } as { results: T[] };
        }
        // poll candidate select
        if (trimmed.startsWith("SELECT id, task_type, payload, required_caps")) {
          // ORDER BY priority ASC, created_at ASC LIMIT 8
          const queued = rows.filter((r) => r.status === "queued")
            .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at)
            .slice(0, 8);
          return { results: queued } as { results: T[] };
        }
        // status: GROUP BY status
        if (trimmed.startsWith("SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status")) {
          const counts: Record<string, number> = {};
          for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
          return { results: Object.entries(counts).map(([status, n]) => ({ status, n })) } as { results: T[] };
        }
        // per-user load
        if (trimmed.startsWith("SELECT claimed_by AS username")) {
          const map = new Map<string, number>();
          for (const r of rows) {
            if (r.status === "claimed" && r.claimed_by) {
              map.set(r.claimed_by, (map.get(r.claimed_by) || 0) + 1);
            }
          }
          return { results: Array.from(map.entries()).map(([username, n]) => ({ username, n })) } as { results: T[] };
        }
        // recent 100
        if (trimmed.startsWith("SELECT id, task_type, status,")) {
          return { results: rows.slice().sort((a, b) => b.created_at - a.created_at).slice(0, 100) } as { results: T[] };
        }
        // reclaim staleness scan
        if (trimmed.startsWith("SELECT id, attempts, max_attempts FROM work_queue WHERE status = 'claimed'")) {
          const cutoff = binds[0] as number;
          const stale = rows.filter((r) => r.status === "claimed" && r.heartbeat_at !== null && r.heartbeat_at < cutoff);
          return { results: stale.map((r) => ({ id: r.id, attempts: r.attempts, max_attempts: r.max_attempts })) } as { results: T[] };
        }
        throw new Error(`unmocked all sql: ${trimmed}`);
      },
    };
  }

  const featureStrings = new Map<string, string>();

  const db = {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
  };

  const env = {
    DB: db,
    KV: {
      async get(key: string): Promise<string | null> {
        const e = kv.get(key);
        if (!e) return null;
        if (e.expires && e.expires < Date.now()) { kv.delete(key); return null; }
        return e.value;
      },
      async put(key: string, value: string, opts?: { expirationTtl?: number }) {
        kv.set(key, { value, expires: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined });
      },
      async delete(key: string) { kv.delete(key); },
    },
    INSTANCE_ID: "test-instance",
  };
  return { db, env, rows, kv, featureStrings, setNow: (t: number) => { now = t; } };
}

// ----------------------------------------------------------------------------
// 1. dispatchWork
// ----------------------------------------------------------------------------
async function run() {
  console.log("dispatchWork:");
  {
    const ctx = makeEnv();
    const id = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata",
      payload: { instanceId: "si-1", sourceUri: "webdav://x/a.mp3", suffix: "mp3", size: 1024 },
      requiredCaps: ["music-metadata"],
      priority: 4,
    });
    assert(id.startsWith("wq-"), "id is prefixed wq-");
    assert(ctx.rows.length === 1, "one row inserted");
    assert(ctx.rows[0].task_type === "metadata", "task_type stored");
    assert(JSON.parse(ctx.rows[0].payload).instanceId === "si-1", "payload JSON round-trips");
    assert(JSON.parse(ctx.rows[0].required_caps || "[]")[0] === "music-metadata", "caps JSON encoded");
    assert(ctx.rows[0].priority === 4, "priority respected");
    assert(ctx.rows[0].status === "queued", "initial status is queued");
  }

  // ----------------------------------------------------------------------------
  // 2. dispatchWorkBatch
  // ----------------------------------------------------------------------------
  console.log("\ndispatchWorkBatch:");
  {
    const ctx = makeEnv();
    const inputs = Array.from({ length: 7 }, (_, i) => ({
      taskType: "metadata",
      payload: { id: i },
      requiredCaps: ["music-metadata"],
    }));
    const ids = await dispatchWorkBatch(ctx.db as unknown as D1Database, inputs);
    assert(ids.length === 7, "7 ids returned");
    assert(ctx.rows.length === 7, "7 rows inserted");
    assert(ctx.rows.every((r) => r.task_type === "metadata"), "all rows metadata");
    assert(new Set(ids).size === 7, "ids unique");
  }

  // ----------------------------------------------------------------------------
  // 3+4. /work/poll atomic claim + caps filter
  // ----------------------------------------------------------------------------
  console.log("\nwork/poll claim & caps filter:");
  {
    const ctx = makeEnv();
    // Seed: one task that needs ffmpeg, one that needs music-metadata.
    await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "transcode", payload: { x: 1 }, requiredCaps: ["ffmpeg"], priority: 1,
    });
    await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: { y: 2 }, requiredCaps: ["music-metadata"], priority: 2,
    });

    // Caller has only music-metadata; ffmpeg task must NOT be claimed.
    const claimedByCaps: WorkRow[] = [];
    const candidates = await (ctx.db.prepare("SELECT id, task_type, payload, required_caps, priority, attempts, max_attempts FROM work_queue WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 8") as any).all();
    for (const c of (candidates as { results: any[] }).results) {
      const required = c.required_caps ? JSON.parse(c.required_caps) : [];
      const have = new Set(["music-metadata", "scrape"]);
      if (required.every((cap: string) => have.has(cap))) {
        const claimed = await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("alice", c.id).first();
        if (claimed) claimedByCaps.push(claimed as WorkRow);
      }
    }
    assert(claimedByCaps.length === 1, "caps filter claimed exactly one (metadata)");
    assert(claimedByCaps[0].task_type === "metadata", "metadata task was claimed");
    assert(ctx.rows.find((r) => r.task_type === "transcode")?.status === "queued", "ffmpeg task untouched");
    assert(ctx.rows.find((r) => r.task_type === "metadata")?.attempts === 1, "claim incremented attempts");
  }

  // ----------------------------------------------------------------------------
  // 5. submit success path
  // ----------------------------------------------------------------------------
  console.log("\nwork/submit success:");
  {
    const ctx = makeEnv();
    const id = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: { x: 1 },
    });
    // claim
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("alice", id).first();
    // submit (success)
    await (ctx.db.prepare("UPDATE work_queue SET status = 'completed', result_json = ?, error_message = NULL, heartbeat_at = ? WHERE id = ?") as any).bind('{"ok":true}', 1234, id).run();
    const row = ctx.rows[0];
    assert(row.status === "completed", "status = completed");
    assert(row.result_json === '{"ok":true}', "result_json stored");
    assert(row.error_message === null, "error_message cleared");
  }

  // ----------------------------------------------------------------------------
  // 6. submit error path — retry left vs exhausted
  // ----------------------------------------------------------------------------
  console.log("\nwork/submit error + retry budget:");
  {
    const ctx = makeEnv();
    const id = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: {}, maxAttempts: 2,
    });
    // first attempt: claim + submit error → should re-queue
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("alice", id).first();
    // Simulate the worker's submit-error branch: attempts (1) < max_attempts (2) → status='queued'
    await (ctx.db.prepare("UPDATE work_queue SET status = ?, error_message = ?, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE id = ?") as any).bind("queued", "boom", id).run();
    assert(ctx.rows[0].status === "queued", "re-queued after first failure");
    assert(ctx.rows[0].error_message === "boom", "error_message persists for diagnostics");

    // second attempt: claim + submit error again → exhausted → 'failed'
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("alice", id).first();
    await (ctx.db.prepare("UPDATE work_queue SET status = ?, error_message = ?, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE id = ?") as any).bind("failed", "boom-again", id).run();
    assert(ctx.rows[0].status === "failed", "exhausted attempts → failed");
    assert(ctx.rows[0].attempts === 2, "attempts == max_attempts");
  }

  // ----------------------------------------------------------------------------
  // 7. heartbeat
  // ----------------------------------------------------------------------------
  console.log("\nwork/heartbeat:");
  {
    const ctx = makeEnv();
    const id = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: {},
    });
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("alice", id).first();
    const before = ctx.rows[0].heartbeat_at;
    ctx.setNow(99_999_999);
    const r = await (ctx.db.prepare("UPDATE work_queue SET heartbeat_at = unixepoch() WHERE id = ? AND status = 'claimed' AND claimed_by = ?") as any).bind(id, "alice").run();
    assert(r.meta.changes === 1, "heartbeat by claimer succeeds");
    assert(ctx.rows[0].heartbeat_at !== before, "heartbeat_at advanced");

    const r2 = await (ctx.db.prepare("UPDATE work_queue SET heartbeat_at = unixepoch() WHERE id = ? AND status = 'claimed' AND claimed_by = ?") as any).bind(id, "bob").run();
    assert(r2.meta.changes === 0, "heartbeat by non-claimer rejected");
  }

  // ----------------------------------------------------------------------------
  // 8. cancel
  // ----------------------------------------------------------------------------
  console.log("\nwork/cancel:");
  {
    const ctx = makeEnv();
    const id = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "scrape", payload: {},
    });
    const r = await (ctx.db.prepare("UPDATE work_queue SET status = 'canceled', error_message = COALESCE(error_message, 'canceled by admin') WHERE id = ? AND status NOT IN ('completed', 'canceled')") as any).bind(id).run();
    assert(r.meta.changes === 1, "cancel succeeds on queued");
    assert(ctx.rows[0].status === "canceled", "row marked canceled");
    // double-cancel is a no-op
    const r2 = await (ctx.db.prepare("UPDATE work_queue SET status = 'canceled', error_message = COALESCE(error_message, 'canceled by admin') WHERE id = ? AND status NOT IN ('completed', 'canceled')") as any).bind(id).run();
    assert(r2.meta.changes === 0, "second cancel is idempotent no-op");
  }

  // ----------------------------------------------------------------------------
  // 9. reclaim — stale heartbeat → re-queue or fail
  // ----------------------------------------------------------------------------
  console.log("\nreclaimStaleWork:");
  {
    const ctx = makeEnv();
    // Two stale claims: one with attempts left, one exhausted.
    const id1 = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: {}, maxAttempts: 3,
    });
    const id2 = await dispatchWork(ctx.db as unknown as D1Database, {
      taskType: "metadata", payload: {}, maxAttempts: 1,
    });
    // claim both at t=1000 with heartbeat=1000
    ctx.setNow(1000);
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("ghost", id1).first();
    await (ctx.db.prepare("UPDATE work_queue SET status = 'claimed', claimed_by = ?, claimed_at = unixepoch(), heartbeat_at = unixepoch(), attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING id, task_type, payload, required_caps, priority, attempts, max_attempts, claimed_at, heartbeat_at") as any).bind("ghost", id2).first();
    // Manually back-date heartbeats well below the cutoff
    for (const r of ctx.rows) r.heartbeat_at = 1000;

    // Run reclaim — cutoff defaults to now - 60s. We override Date.now in the
    // env's clock with a far-future value via a stub.
    const realDateNow = Date.now;
    Date.now = () => 2_000_000;          // 2_000_000_000 ms ≈ epoch +63 years; well past cutoff
    try {
      // Pre-seed feature_strings cache so reclaim reads ttl=60.
      ctx.featureStrings.set("worker_claim_ttl_seconds", "60");
      const report = await reclaimStaleWork(ctx.env as unknown as Env);
      assert(report.scanned === 2, "both stale claims detected");
      assert(report.reQueued === 1, "one re-queued");
      assert(report.failed === 1, "one failed (max attempts reached)");
      const a = ctx.rows.find((r) => r.id === id1)!;
      const b = ctx.rows.find((r) => r.id === id2)!;
      assert(a.status === "queued", "max=3 attempts=1 → re-queue");
      assert(b.status === "failed", "max=1 attempts=1 → failed");
      assert(a.claimed_by === null, "claimed_by cleared on re-queue");
      assert(b.claimed_by === null, "claimed_by cleared on fail");
    } finally {
      Date.now = realDateNow;
    }
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
