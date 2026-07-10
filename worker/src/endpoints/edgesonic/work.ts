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
import { applyMetadataResult } from "../../utils/metadataApply";
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

  // path knows whether to cascade the result into song_masters/song_instances.
  // Before 077 we only ever stored result_json against work_queue and called it
  // done; admins saw rows pile up as "completed" while song_instances stayed
  // tag_scanned=0 (82 completed → 1 with tag_scanned, per Rosmontis' report).
  const row = await env.DB.prepare(
    "SELECT status, claimed_by, attempts, max_attempts, task_type, payload FROM work_queue WHERE id = ?",
  ).bind(body.id).first<{
    status: string;
    claimed_by: string | null;
    attempts: number;
    max_attempts: number;
    task_type: string;
    payload: string;
  }>();
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
  // the business tables BEFORE flipping work_queue.status. The apply is best-
  // effort: a failure (e.g. instance row got deleted between dispatch and
  // submit) is recorded in result_json's "apply" annotation, but we still
  // mark the task completed so the queue doesn't churn forever. Admins can
  // re-run the backfill endpoint if they want to retry.
  // 093e — raised from 100KB to 500KB to accommodate embedded cover art
  // (base64-encoded, up to 200KB raw → ~270KB base64). D1 TEXT has no
  // practical row-size limit at this scale.
  const resultJson = body.result === undefined ? null : JSON.stringify(body.result).slice(0, 500_000);
  let applyAnnotation: { ok: boolean; reason?: string; masterId?: string } | undefined;
  if (row.task_type === "metadata" && body.result && typeof body.result === "object") {
    try {
      const r = body.result as Record<string, unknown>;
      const tags = (r.tags && typeof r.tags === "object") ? r.tags as Record<string, unknown> : {};
      // result.instanceId is what the worker actually processed; fall back to
      // the dispatched payload (52a stores it as a JSON column) when the
      // worker forgot to echo it. Both should always agree.
      let instanceId = typeof r.instanceId === "string" ? r.instanceId : "";
      if (!instanceId) {
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          if (typeof payload?.instanceId === "string") instanceId = payload.instanceId;
        } catch { /* malformed payload — falls through to "missing instanceId" */ }
      }
      const apply = await applyMetadataResult(env.DB, instanceId, tags, tags);
      applyAnnotation = apply.updated
        ? { ok: true, masterId: apply.masterId }
        : { ok: false, reason: apply.reason };
      // 093e — if the worker extracted an embedded cover and the apply
      // produced a masterId (so we know which album to attach it to), write
      // the cover bytes to R2 and update albums.cover_r2_key. Best-effort:
      // a failure here doesn't fail the task (metadata was still applied).
      if (apply.masterId && r.cover && typeof r.cover === "object") {
        try {
          const cover = r.cover as { data?: string; mime?: string };
          if (typeof cover.data === "string" && cover.data.length > 0) {
            // Decode base64 to bytes.
            const bin = atob(cover.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            // Look up the album_id for this master.
            const masterRow = await env.DB.prepare(
              "SELECT album_id FROM song_masters WHERE id = ?",
            ).bind(apply.masterId).first<{ album_id: string }>();
            if (masterRow?.album_id) {
              const coverKey = `covers/al-${masterRow.album_id}`;
              const mime = (cover.mime || "image/jpeg").startsWith("image/")
                ? cover.mime : `image/${cover.mime || "jpeg"}`;
              await (env as Env).MUSIC_BUCKET.put(coverKey, bytes, {
                httpMetadata: { contentType: mime },
              });
              await env.DB.prepare(
                "UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ? AND cover_r2_key IS NULL",
              ).bind(coverKey, Math.floor(Date.now() / 1000), masterRow.album_id).run();
            }
          }
        } catch (e) {
          // Cover write failure is non-fatal — metadata already applied.
          console.error(`[work/submit] cover write failed for ${instanceId}:`, e);
        }
      }
    } catch (e) {
      // We deliberately swallow — the queue row still gets marked completed
      // so workers don't re-poll the same task indefinitely. Backfill is the
      // recovery path.
      applyAnnotation = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  await env.DB.prepare(
    `UPDATE work_queue
     SET status = 'completed', result_json = ?, error_message = NULL,
         heartbeat_at = ?
     WHERE id = ?`,
  ).bind(resultJson, now, body.id).run();
  return c.json({
    ok: true,
    status: "completed",
    ...(applyAnnotation ? { applied: applyAnnotation } : {}),
  });
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
// dispatch_work permission (super-admin by default per 052a); pre-087 used a
// hardcoded `if (user.level < 3)` which violated the permission-model rule.
workRoutes.get("/work/status", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;

  // Aggregate by status.
  const counts = (await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM work_queue GROUP BY status`,
  ).all<{ status: string; n: number }>()).results;
  const byStatus: Record<string, number> = { queued: 0, claimed: 0, completed: 0, failed: 0, canceled: 0 };
  for (const r of counts) byStatus[r.status] = r.n;

  // Per-user active load — claimed tasks OR recently completed (last 60s)
  // so the "active workers" list doesn't flicker to empty between poll cycles
  // when a task finishes but the next hasn't been claimed yet.
  const nowSec = Math.floor(Date.now() / 1000);
  const load = (await env.DB.prepare(
    `SELECT claimed_by AS username, COUNT(*) AS n
     FROM work_queue
     WHERE status = 'claimed' AND claimed_by IS NOT NULL
     GROUP BY claimed_by
     UNION ALL
     SELECT claimed_by AS username, COUNT(*) AS n
     FROM work_queue
     WHERE status = 'completed' AND claimed_by IS NOT NULL
       AND heartbeat_at IS NOT NULL AND heartbeat_at > ?
     GROUP BY claimed_by`,
  ).bind(nowSec - 60).all<{ username: string; n: number }>()).results;
  // Merge duplicate usernames from the UNION
  const merged = new Map<string, number>();
  for (const r of load) merged.set(r.username, (merged.get(r.username) ?? 0) + r.n);
  const loadMerged = Array.from(merged.entries()).map(([username, n]) => ({ username, n }));

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
    load: loadMerged,
    recent,
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/cancel { id }
// ---------------------------------------------------------------------------
// permission (super-admin default per 052a). A regular worker can't drop
// somebody else's queued metadata batch because they don't hold the
// permission row; the previous level<3 check was a violation of the
// permission-model rule.
workRoutes.post("/work/cancel", permissionMiddleware("dispatch_work"), async (c) => {
  const env = c.env as Env;
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

// ---------------------------------------------------------------------------
// POST /edgesonic/work/backfillCompleted
// ---------------------------------------------------------------------------
// before the cascade was wired in (status='completed', task_type='metadata',
// result_json IS NOT NULL). The fix to /work/submit means new rows land
// correctly; this endpoint is the migration path for the ~82 historical rows
// that completed but never wrote tag_scanned=1.
//
// We process rows sequentially (one applyMetadataResult per row) so a partial
// failure on row N doesn't cancel rows N+1..M. The response carries a small
// errors[] sample so admins can spot patterns (e.g. all failures hitting the
// same source) without exploding the JSON body.
//
// Admin-only — 087: gated by dispatch_work (super-admin per 052a), same gate
// as /work/status. A regular worker should never need to trigger this.
workRoutes.post("/work/backfillCompleted",
  permissionMiddleware("dispatch_work"),
  async (c) => {
  const env = c.env as Env;

  // Hard cap the candidate set so a runaway call can't pull a million rows
  // into memory. The query optionally accepts ?limit= to override (admins
  // may want to chunk through millions of rows; default keeps the call cheap).
  const rawLimit = parseInt(c.req.query("limit") || "1000", 10);
  const limit = Math.max(1, Math.min(10000, Number.isFinite(rawLimit) ? rawLimit : 1000));

  const candidates = (await env.DB.prepare(
    `SELECT id, payload, result_json
     FROM work_queue
     WHERE status = 'completed'
       AND task_type = 'metadata'
       AND result_json IS NOT NULL
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(limit).all<{ id: string; payload: string; result_json: string }>()).results;

  let processed = 0;
  let applied = 0;
  let failed = 0;
  const errors: { id: string; error: string }[] = [];

  for (const cand of candidates) {
    processed++;
    try {
      const result = JSON.parse(cand.result_json) as Record<string, unknown>;
      const tags = (result.tags && typeof result.tags === "object")
        ? result.tags as Record<string, unknown>
        : {};
      let instanceId = typeof result.instanceId === "string" ? result.instanceId : "";
      if (!instanceId) {
        try {
          const payload = JSON.parse(cand.payload) as Record<string, unknown>;
          if (typeof payload?.instanceId === "string") instanceId = payload.instanceId;
        } catch { /* missing payload — caught below as "missing instanceId" */ }
      }
      const apply = await applyMetadataResult(env.DB, instanceId, tags, tags);
      if (apply.updated) {
        applied++;
      } else {
        failed++;
        if (errors.length < 20) errors.push({ id: cand.id, error: apply.reason || "unknown" });
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      if (errors.length < 20) errors.push({ id: cand.id, error: msg });
    }
  }

  return c.json({ ok: true, processed, applied, failed, errors });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/work/recheckMetadataNow
// ---------------------------------------------------------------------------
// (maybeRunMetadataRecheck / utils/metadataRecheck.ts), bypassing the
// metadata_recheck_interval_hours cadence gate so an admin can kick off a
// re-check immediately instead of waiting up to 24h. Same permission gate as
// the other work-queue admin endpoints.
workRoutes.post("/work/recheckMetadataNow",
  permissionMiddleware("dispatch_work"),
  async (c) => {
    const env = c.env as Env;
    const { runMetadataRecheck } = await import("../../utils/metadataRecheck");
    const result = await runMetadataRecheck(env.DB);
    return c.json({ ok: true, ...result });
  },
);

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
  // and the INSERT is INSERT OR IGNORE — re-dispatching the same logical task
  // (e.g. same song_instances.id metadata parse) is a no-op instead of piling
  // up duplicate rows in work_queue. Scan.ts uses this with the instanceId.
  dedupKey?: string;
  // 118 — dedupKey + plain INSERT OR IGNORE is a *one-shot-ever* mechanism:
  // once a row with that deterministic id exists (in ANY terminal state —
  // completed/failed/canceled), every future re-dispatch under the same key
  // silently no-ops. That's correct for the common "don't pile up duplicates
  // while still queued/claimed" case, but wrong for an explicit force-rescan
  // — the whole point of "re-run the metadata pipeline anyway" is to make an
  // already-completed row runnable again. Set upsert=true to switch the
  // INSERT to `ON CONFLICT(id) DO UPDATE` so a stale row is kicked back to
  // 'queued' with a fresh attempts counter instead of being ignored. Only
  // meaningful when dedupKey is also set.
  upsert?: boolean;
}

const REDISPATCH_CONFLICT_CLAUSE = `
     ON CONFLICT(id) DO UPDATE SET
       status = 'queued', payload = excluded.payload, priority = excluded.priority,
       max_attempts = excluded.max_attempts, attempts = 0, error_message = NULL,
       claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
       result_json = NULL, expires_at = excluded.expires_at`;

export async function dispatchWork(db: D1Database, input: DispatchInput): Promise<string> {
  // a re-dispatch becomes a no-op; the caller still gets the canonical id back
  // and can look it up regardless of whether the INSERT actually inserted.
  const id = input.dedupKey
    ? `wt-${input.taskType}-${input.dedupKey}`
    : "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const priority = clampInt(input.priority ?? 5, 1, 10);
  const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
  const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
    ? JSON.stringify(input.requiredCaps)
    : null;
  const insertVerb = input.dedupKey && !input.upsert ? "INSERT OR IGNORE INTO" : "INSERT INTO";
  const conflictClause = input.dedupKey && input.upsert ? REDISPATCH_CONFLICT_CLAUSE : "";
  await db.prepare(
    `${insertVerb} work_queue (id, task_type, payload, required_caps, priority,
                              status, max_attempts, expires_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)${conflictClause}`,
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
    // Per-row decision so the same batch can mix deduped + non-deduped rows.
    const id = input.dedupKey
      ? `wt-${input.taskType}-${input.dedupKey}`
      : "wq-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
    ids.push(id);
    const priority = clampInt(input.priority ?? 5, 1, 10);
    const maxAttempts = clampInt(input.maxAttempts ?? 3, 1, 10);
    const requiredCapsJson = input.requiredCaps && input.requiredCaps.length > 0
      ? JSON.stringify(input.requiredCaps)
      : null;
    const insertVerb = input.dedupKey && !input.upsert ? "INSERT OR IGNORE INTO" : "INSERT INTO";
    const conflictClause = input.dedupKey && input.upsert ? REDISPATCH_CONFLICT_CLAUSE : "";
    stmts.push(
      db.prepare(
        `${insertVerb} work_queue (id, task_type, payload, required_caps, priority,
                                    status, max_attempts, expires_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)${conflictClause}`,
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
