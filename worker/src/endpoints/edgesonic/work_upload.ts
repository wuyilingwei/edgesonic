//
// POST /edgesonic/work/upload?id=<workQueueId>&token=<hmac>
//
// Body: raw bytes (the ffmpeg.wasm output produced by web/src/workers/
// taskExecutor.ts).
// Auth:
//  1. session middleware (router-level) — anyone signed-in passes through
//  2. HMAC token (workUploadToken.signUploadToken) — 5-minute TTL
//  3. work_queue.claimed_by === user.username — even with a leaked token,
//    only the worker that actually claimed this row can deposit bytes.
//    The check happens in code so the failure mode is observable in the
//    response (403 with reason) instead of a generic 404.
// Effect:
//  Writes R2 key `cache/transcoded/<instanceId>_<profileId>.<container>`
//  based on the payload that was queued. Returns { ok, r2Key, size }.
//
// The route is intentionally NOT colocated with work.ts — that file already
// hit 450 lines and the upload path has a different shape (binary body, not
// JSON; no permission middleware). Keeping it separate keeps the diff
// reviewable.

import { Hono } from "hono";
import type { User } from "../../types/entities";
import type { TranscodePayload } from "../../transcode/browser_pool";
import { verifyUploadToken } from "../../utils/workUploadToken";
import { createQueries } from "../../db/queries";
import { getProfile } from "../../transcode/profiles";

export const workUploadRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// Maximum bytes we will accept in a single upload. ffmpeg.wasm output for a
// FLAC-lossless transcode of a long album track can reach ~80MB; we set
// 256MB as a safety ceiling — anything past that almost certainly means a
// runaway browser is dumping the wrong file.
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

workUploadRoutes.post("/work/upload", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  const id = c.req.query("id") || "";
  const token = c.req.query("token") || "";
  if (!id || !token) {
    return c.json({ ok: false, error: "Missing id or token" }, 400);
  }

  // 1. HMAC + TTL check. Generic 401 on failure so we don't leak whether
  //  the token expired vs. was malformed.
  const verified = await verifyUploadToken(env, id, token);
  if (!verified.ok) {
    return c.json({ ok: false, error: "Invalid or expired token" }, 401);
  }

  // 2. Load the work_queue row. We need claimed_by + payload to figure out
  //  where to write the bytes in R2.
  const row = await env.DB.prepare(
    `SELECT id, task_type, status, claimed_by, payload
       FROM work_queue WHERE id = ?`,
  ).bind(id).first<{
    id: string;
    task_type: string;
    status: string;
    claimed_by: string | null;
    payload: string;
  }>();
  if (!row) return c.json({ ok: false, error: "Task not found" }, 404);
  if (row.task_type !== "transcode") {
    return c.json({ ok: false, error: "Task is not a transcode" }, 400);
  }
  if (row.status !== "claimed") {
    return c.json({ ok: false, error: `Task is ${row.status}, not claimed` }, 409);
  }
  if (row.claimed_by !== user.username) {
    return c.json({ ok: false, error: "Task is claimed by another worker" }, 403);
  }

  // 3. Parse payload — needed for the R2 key. Defensive: a malformed row
  //  would imply a corrupt queue, not a bad client, but we still 500.
  let payload: TranscodePayload;
  try { payload = JSON.parse(row.payload) as TranscodePayload; }
  catch {
    return c.json({ ok: false, error: "Corrupt task payload" }, 500);
  }
  if (!payload.instanceId || !payload.profileId || !payload.outputSuffix) {
    return c.json({ ok: false, error: "Task payload missing fields" }, 500);
  }

  // 4. Body — Workers' c.req.arrayBuffer() consumes the entire request body.
  //  Reject early on Content-Length too big; the actual buffered length is
  //  re-checked after read in case the header lied.
  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10);
  if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    return c.json({ ok: false, error: "Empty body" }, 400);
  }
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }

  // 5. Write to R2. Path scheme `cache/transcoded/<instanceId>_<profile>.<suffix>`
  //  matches the pre-bake convention the rest of EdgeSonic will eventually
  //  use.
  const r2Key = `cache/transcoded/${payload.instanceId}_${payload.profileId}.${payload.outputSuffix}`;
  // Prefer the profile catalogue's contentType (authoritative MIME for the
  // codec/container pair) over whatever the browser uploaded with. The
  // browser may send `application/octet-stream` to dodge ffmpeg.wasm output
  // sniffing — that's fine for the R2 put but bad for the song_instances
  // row that stream selection ultimately reads.
  const profile = getProfile(payload.profileId);
  const reqContentType = c.req.header("Content-Type");
  const contentType = profile?.contentType
    || reqContentType
    || suffixToMime(payload.outputSuffix)
    || "application/octet-stream";
  await env.MUSIC_BUCKET.put(r2Key, buf, {
    httpMetadata: { contentType },
  });

  // 6. Register the resulting song_instances row so future identical /stream
  //  requests (same master + same profile) bypass the engine entirely.
  //  We DON'T fail the upload if D1 INSERT fails: the R2 bytes are still
  //  valid and the worker shouldn't be marked failed for an indexing miss
  //  (FK violation if the original instance was deleted between enqueue
  //  and upload). Callers see registered:false in the ack and can
  //  diagnose from logs.
  let registered = false;
  let registeredInstanceId: string | null = null;
  try {
    const queries = createQueries(env.DB);
    const parent = await env.DB.prepare(
      "SELECT master_id FROM song_instances WHERE id = ?",
    ).bind(payload.instanceId).first<{ master_id: string }>();
    if (parent?.master_id) {
      // 16 hex chars from a uuidv4 → ~64 bits of entropy, collision-free at
      // EdgeSonic's scale and visually distinguishable from upload-flow ids.
      const newId = "si-bp-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
      const inserted = await queries.registerTranscodedInstance({
        id: newId,
        masterId: parent.master_id,
        parentInstanceId: payload.instanceId,
        storageUri: `r2://${r2Key}`,
        transcodeProfile: payload.profileId,
        suffix: payload.outputSuffix,
        contentType,
        bitRate: profile?.bitrate ?? 0,
        size: buf.byteLength,
      });
      if (inserted) {
        registered = true;
        registeredInstanceId = inserted;
      }
    }
  } catch {
    // swallow: see comment above
  }

  return c.json({
    ok: true,
    r2Key,
    size: buf.byteLength,
    registered,
    instanceId: registeredInstanceId,
  });
});

// Tiny suffix → MIME fallback for when the profile lookup misses (unknown
// profile id sneaked through enqueue). Kept narrow to the containers the
// 049 catalogue actually emits.
function suffixToMime(suffix: string): string | null {
  switch (suffix.toLowerCase()) {
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "opus": return "audio/opus";
    case "ogg":  return "audio/ogg";
    case "flac": return "audio/flac";
    default:     return null;
  }
}
