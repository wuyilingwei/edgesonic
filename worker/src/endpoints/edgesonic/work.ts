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

// 052 — Browser worker pool endpoints.
//
// All endpoints are JSON-shaped (the /edgesonic/* bucket is web-session only,
// the web frontend consumes JSON). Authorisation matrix:
//
//   GET  /edgesonic/work/poll       — permission participate_work
//   POST /edgesonic/work/submit     — claimed_by must equal current user
//   POST /edgesonic/work/heartbeat  — claimed_by must equal current user
//   POST /edgesonic/work/dispatch   — permission dispatch_work (super-admin)
//   GET  /edgesonic/work/status     — level >= 3 (super-admin)
//   POST /edgesonic/work/cancel     — level >= 3 (super-admin)
//
// The atomic claim uses D1's RETURNING clause inside a single UPDATE-by-subquery
// so two browsers can't grab the same row. caps filtering is done on the worker
// side (D1 has no array containment operator) — we read candidate rows with
// required_caps NULL OR required_caps LIKE '%cap%' then filter in JS.
//
// Reclaim of stale claims (heartbeat older than worker_claim_ttl_seconds) is
// handled by reclaimStaleWork(), wired into index.ts scheduled handler.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeatureString } from "../../utils/features";
import type { User } from "../../types/entities";

export const workRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// Shape of a work_queue row as returned to a polling worker. Keeps the over-
// the-wire payload narrow so a curious user can't read every column.
interface PolledTask {
  id: string;
  taskType: string;
  payload: unknown;
  requiredCaps: string[];
  priority: number;
  attempts: number;
  maxAttempts: number;
  claimedAt: number;
  heartbeatAt: number;
}

// ---------------------------------------------------------------------------
// GET /edgesonic/work/poll?caps=a,b,c&limit=5
// ---------------------------------------------------------------------------
// Atomically claims up to `limit` queued tasks whose required_caps are a
// subset of the caller's caps. Each claim runs as a separate UPDATE ...
// RETURNING so we never hand the same row to two workers.
workRoutes.get("/work/poll", permissionMiddleware("participate_work"), async (c) => {
  const env = c.env as Env;
  const user = c.get("user");

  // Kill-switch: if worker_pool_enabled='0' return an empty list (the client
  // will keep polling at the configured cadence but nothing will move).
  const enabled = (await getFeatureString(env, "worker_pool_enabled", "1")) !== "0";
  if (!enabled) {
    return c.json({ ok: true, tasks: [] });
  }

  const callerCaps = parseCaps(c.req.query("caps") || "");
  const rawLimit = parseInt(c.req.query("limit") || "5", 10);
  const batchCeiling = parseInt(await getFeatureString(env, "worker_batch_size", "5"), 10);
  const ceiling = Number.isFinite(batchCeiling) && batchCeiling > 0 ? batchCeiling : 5;
  // Don't let a client ask for more than the server-side batch ceiling.
  const limit = Math.max(1, Math.min(ceiling, Number.isFinite(rawLimit) ? rawLimit : 5));

  const claimed: PolledTask[] = [];
  // Each iteration claims at most one row. We over-iterate by a factor of 2
  // so caps mismatches don't starve the client before we hit `limit`.
  for (let attempt = 0; attempt < limit * 2 && claimed.length < limit; attempt++) {
    // Try to claim the highest-priority oldest task whose caps are satisfied.
    // We pre-filter with a SELECT (no LOCK needed; the subsequent UPDATE
    // with RETURNING is the actual claim).
    const candidates = (await env.DB.prepare(
      `SELECT id, task_type, payload, required_caps, priority, attempts, max_attempts
       FROM work_queue
       WHERE status = 'queued'
       ORDER BY priority ASC, created_at ASC
       LIMIT 8`,
    ).all<{
      id: string;
      task_type: string;
      payload: string;
      required_caps: string | null;
      priority: number;
      attempts: number;
      max_attempts: number;
    }>()).results;

    let target: string | null = null;
    for (const row of candidates) {
      const required = parseCaps(row.required_caps);
      if (capsSatisfy(callerCaps, required)) {
        target = row.id;
        break;
      }
    }
    if (!target) break;             // nothing this worker can do this round

    // UPDATE-by-subquery + RETURNING: atomic per-row claim. We constrain the
    // UPDATE to status='queued' so two simultaneous claims collide harmlessly
    // (the second one's WHERE turns false).
    const row = await env.DB.prepare(
      `UPDATE work_queue
       SET status = 'claimed',
           claimed_by = ?,
           claimed_at = unixepoch(),
           heartbeat_at = unixepoch(),
           attempts = attempts + 1
       WHERE id = ? AND status = 'queued'
       RETURNING id, task_type, payload, required_caps, priority,
                 attempts, max_attempts, claimed_at, heartbeat_at`,
    ).bind(user.username, target).first<{
      id: string;
      task_type: string;
      payload: string;
      required_caps: string | null;
      priority: number;
      attempts: number;
      max_attempts: number;
      claimed_at: number;
      heartbeat_at: number;
    }>();
    if (!row) continue;             // someone else grabbed it; try the next candidate

    claimed.push({
      id: row.id,
      taskType: row.task_type,
      payload: safeJsonParse(row.payload),
      requiredCaps: parseCaps(row.required_caps),
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      claimedAt: row.claimed_at,
      heartbeatAt: row.heartbeat_at,
    });
  }

  return c.json({ ok: true, tasks: claimed });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/submit { id, result?, error? }
// ---------------------------------------------------------------------------
// Marks a claimed task as completed (success path) or failed (error path).
// Only the worker that claimed the task may submit — prevents another browser
// from polluting the result.
workRoutes.post("/work/submit", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  let body: { id?: string; result?: unknown; error?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);

  const row = await env.DB.prepare(
    "SELECT status, claimed_by, attempts, max_attempts FROM work_queue WHERE id = ?",
  ).bind(body.id).first<{ status: string; claimed_by: string | null; attempts: number; max_attempts: number }>();
  if (!row) return c.json({ ok: false, error: "Task not found" }, 404);
  if (row.status !== "claimed") {
    return c.json({ ok: false, error: `Task is ${row.status}, not claimed` }, 409);
  }
  if (row.claimed_by !== user.username) {
    return c.json({ ok: false, error: "Task is claimed by another worker" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  if (body.error) {
    // Failure path. If attempts exhausted → final 'failed', otherwise re-queue
    // for another browser to pick up. We deliberately keep error_message even
    // on re-queue so admins can read the prior failure reason in status.
    const willRetry = row.attempts < row.max_attempts;
    await env.DB.prepare(
      `UPDATE work_queue
       SET status = ?, error_message = ?, claimed_by = NULL,
           claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`,
    ).bind(willRetry ? "queued" : "failed", body.error.slice(0, 500), body.id).run();
    return c.json({ ok: true, status: willRetry ? "queued" : "failed" });
  }

  // Success path.
  const resultJson = body.result === undefined ? null : JSON.stringify(body.result).slice(0, 100_000);
  await env.DB.prepare(
    `UPDATE work_queue
     SET status = 'completed', result_json = ?, error_message = NULL,
         heartbeat_at = ?
     WHERE id = ?`,
  ).bind(resultJson, now, body.id).run();
  return c.json({ ok: true, status: "completed" });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/heartbeat { id }
// ---------------------------------------------------------------------------
// Long-running task keep-alive. The client should call this every
// worker_claim_ttl_seconds / 2 while a transcode is in-flight; metadata tasks
// are short enough to finish before the first heartbeat would be due.
workRoutes.post("/work/heartbeat", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  let body: { id?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);

  // We UPDATE-AND-CHECK in a single statement: the WHERE clause guards both
  // ownership and current state, so the meta.changes tells us whether the
  // heartbeat landed.
  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET heartbeat_at = unixepoch()
     WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
  ).bind(body.id, user.username).run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: "Not your claim or task no longer active" }, 409);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/dispatch { task_type, payload, priority?, required_caps?, max_attempts? }
// ---------------------------------------------------------------------------
// Manually push a task onto the queue. Used by admins for ad-hoc work
// (re-scrape one album, force re-transcode a song) and by background entry
// points (scan.ts) for batch dispatches.
workRoutes.post("/work/dispatch", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
  let body: {
    task_type?: string;
    payload?: unknown;
    priority?: number;
    required_caps?: string[];
    max_attempts?: number;
    expires_at?: number;
  };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.task_type || !ALLOWED_TASK_TYPES.has(body.task_type)) {
    return c.json({ ok: false, error: `Unknown task_type: ${body.task_type}` }, 400);
  }
  if (body.payload === undefined) {
    return c.json({ ok: false, error: "Missing payload" }, 400);
  }
  const id = await dispatchWork(env.DB, {
    taskType: body.task_type,
    payload: body.payload,
    priority: body.priority,
    requiredCaps: body.required_caps,
    maxAttempts: body.max_attempts,
    expiresAt: body.expires_at,
  });
  return c.json({ ok: true, id });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/work/status — admin overview.
// ---------------------------------------------------------------------------
// One D1 aggregate + one per-user load + the last 100 rows. Only level=3 may
// call it (so a regular worker can't enumerate everyone's tasks).
workRoutes.get("/work/status", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  if (user.level < 3) {
    return c.json({ ok: false, error: "Admin level required" }, 403);
  }

  // Aggregate by status.
  const counts = (await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status`,
  ).all<{ status: string; n: number }>()).results;
  const byStatus: Record<string, number> = { queued: 0, claimed: 0, completed: 0, failed: 0, canceled: 0 };
  for (const r of counts) byStatus[r.status] = r.n;

  // Per-user active load (claimed tasks only — completed/failed don't count
  // towards live workload).
  const load = (await env.DB.prepare(
    `SELECT claimed_by AS username, COUNT(*) AS n
     FROM work_queue
     WHERE status = 'claimed' AND claimed_by IS NOT NULL
     GROUP BY claimed_by`,
  ).all<{ username: string; n: number }>()).results;

  // Recent 100 rows (newest first) — surfaces stuck tasks at a glance.
  const recent = (await env.DB.prepare(
    `SELECT id, task_type, status, claimed_by, attempts, max_attempts,
            priority, created_at, heartbeat_at, error_message
     FROM work_queue
     ORDER BY created_at DESC
     LIMIT 100`,
  ).all<{
    id: string;
    task_type: string;
    status: string;
    claimed_by: string | null;
    attempts: number;
    max_attempts: number;
    priority: number;
    created_at: number;
    heartbeat_at: number | null;
    error_message: string | null;
  }>()).results;

  return c.json({
    ok: true,
    counts: byStatus,
    load,
    recent,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/cancel { id }
// ---------------------------------------------------------------------------
// Force-cancel a task regardless of state. Only level=3 — a worker shouldn't
// be able to drop somebody else's queued metadata batch.
workRoutes.post("/work/cancel", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  if (user.level < 3) {
    return c.json({ ok: false, error: "Admin level required" }, 403);
  }
  let body: { id?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.id) return c.json({ ok: false, error: "Missing id" }, 400);

  const result = await env.DB.prepare(
    `UPDATE work_queue
     SET status = 'canceled', error_message = COALESCE(error_message, 'canceled by admin')
     WHERE id = ? AND status NOT IN ('completed', 'canceled')`,
  ).bind(body.id).run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: "Task not found or already terminal" }, 404);
  }
  return c.json({ ok: true });
});

// ===========================================================================
// dispatchWork helper — shared with scan.ts (background batch dispatch).
// ===========================================================================
export interface DispatchInput {
  taskType: string;
  payload: unknown;
  priority?: number;
  requiredCaps?: string[];
  maxAttempts?: number;
  expiresAt?: number;
}

export async function dispatchWork(db: D1Database, input: DispatchInput): Promise<string> {
  const id = "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const priority = clampInt(input.priority ?? 5, 1, 10);
  const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
  const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
    ? JSON.stringify(input.requiredCaps)
    : null;
  await db.prepare(
    `INSERT INTO work_queue (id, task_type, payload, required_caps, priority,
                              status, max_attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(
    id,
    input.taskType,
    JSON.stringify(input.payload),
    requiredCapsJson,
    priority,
    maxAttempts,
    input.expiresAt ?? null,
  ).run();
  return id;
}

// Batch dispatch — used by scan.ts when 1758 files become pending at once.
// One D1 INSERT per row via batch(), in chunks of 80 to stay under the D1
// batch limit. Returns the list of created ids so the caller can log.
export async function dispatchWorkBatch(
  db: D1Database,
  inputs: DispatchInput[],
): Promise<string[]> {
  const ids: string[] = [];
  if (inputs.length === 0) return ids;

  const stmts: D1PreparedStatement[] = [];
  for (const input of inputs) {
    const id = "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    ids.push(id);
    const priority = clampInt(input.priority ?? 5, 1, 10);
    const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
    const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
      ? JSON.stringify(input.requiredCaps)
      : null;
    stmts.push(
      db.prepare(
        `INSERT INTO work_queue (id, task_type, payload, required_caps, priority,
                                  status, max_attempts, expires_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).bind(
        id,
        input.taskType,
        JSON.stringify(input.payload),
        requiredCapsJson,
        priority,
        maxAttempts,
        input.expiresAt ?? null,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 80) {
    await db.batch(stmts.slice(i, i + 80));
  }
  return ids;
}

// ===========================================================================
// Helpers
// ===========================================================================
const ALLOWED_TASK_TYPES = new Set(["metadata", "transcode", "scrape"]);

function parseCaps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Accept either "a,b,c" (poll query) or a JSON array (work_queue column).
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
      }
    } catch { /* fall through */ }
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function capsSatisfy(callerCaps: string[], required: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(callerCaps);
  for (const cap of required) {
    if (!have.has(cap)) return false;
  }
  return true;
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
