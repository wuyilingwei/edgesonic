//
// Unlike SandboxTranscodeEngine / ExternalTranscodeEngine, this backend does
// NOT run ffmpeg itself — it just turns a transcode request into a
// work_queue row and waits for a browser-resident worker (52b) to pick it up,
// decode the source, run ffmpeg.wasm and upload the result. The trade-off:
//  + Zero Worker CPU / memory cost. No paid Sandbox container.
//  + Capacity scales linearly with the number of browser tabs open.
//  - Cannot serve real-time `/rest/stream` transcoding (latency is too
//   unpredictable). Callers detect the engine kind and fall back to raw
//   while pre-baking the requested profile asynchronously.
//  - The browser-side worker writes its bytes back via
//   `/edgesonic/work/upload?id=…&token=…` (HMAC-signed, 5 minute TTL).
//
// Because the engine is async-only, `transcode()` is implemented as a hard
// failure: any call path that goes through it without first short-circuiting
// on `kind === 'browser_pool'` is a programming error and should be loud.
// The dispatcher in endpoints/transcode.ts + media.ts is the authority on
// when to call enqueueTranscodeTask() instead.

import type {
  TranscodeEngine,
  TranscodeInput,
  TranscodeJobRow,
  TranscodeOutput,
  TranscodeProfile,
} from "./engine";
import { buildFfmpegArgs } from "./profiles";
import { dispatchWork } from "../endpoints/edgesonic/work";

// Payload shape persisted in work_queue.payload (JSON). Kept narrow so the
// browser-side executor (web/src/workers/taskExecutor.ts) can act on it with
// nothing more than the stringly-typed inputs.
export interface TranscodePayload {
  sourceUri: string;     // signed /rest/stream URL the browser will GET
  instanceId: string;    // the song instance being transcoded — used to name the R2 key
  profileId: string;     // stable profile reference (matches profiles.ts)
  outputSuffix: string;  // container, e.g. "mp3" / "m4a" / "opus"
  ffmpegArgs: string[];  // pre-computed argv minus the binary name
  uploadUrl: string;     // /edgesonic/work/upload?id=…&token=… ready to POST to
}

export class BrowserPoolEngine implements TranscodeEngine {
  readonly name = "browser_pool";

  // The D1 binding is required for enqueue / status / cancel. The R2 bucket
  // is kept as a constructor argument for symmetry with the other engines
  // (and for future direct-write helpers), even though enqueueing itself
  // never touches R2 — that's the browser-side worker's job through
  // /work/upload.
  constructor(private readonly db: D1Database, private readonly bucket: R2Bucket) {}

  // Synchronous transcode is fundamentally incompatible with the queue
  // model — the request would have to block on a browser polling the queue,
  // claiming the row, decoding, ffmpeg'ing and uploading the result, with
  // no upper bound. We surface that as a hard error rather than time-out
  // the inbound /stream or /transcodeFile request.
  async transcode(_input: TranscodeInput, _profile: TranscodeProfile): Promise<TranscodeOutput> {
    throw new Error(
      "BrowserPoolEngine does not support synchronous transcode; " +
      "use enqueueTranscodeTask() instead",
    );
  }

  // Look up the work_queue row for a given queue id. We project it into the
  // legacy TranscodeJobRow shape (049) so existing callers can keep treating
  // a "job" uniformly — the only fields we can fill from work_queue are
  // status / error / created_at; the rest stay null/empty.
  async getStatus(jobId: string): Promise<TranscodeJobRow | null> {
    const row = await this.db.prepare(
      `SELECT id, task_type, payload, status, error_message, created_at
       FROM work_queue WHERE id = ?`,
    ).bind(jobId).first<{
      id: string;
      task_type: string;
      payload: string;
      status: string;
      error_message: string | null;
      created_at: number;
    }>();
    if (!row) return null;
    if (row.task_type !== "transcode") return null;

    let payload: Partial<TranscodePayload> = {};
    try { payload = JSON.parse(row.payload) as Partial<TranscodePayload>; }
    catch { /* leave defaults */ }

    // Map work_queue.status onto TranscodeStatus. queued/claimed → processing
    // so the caller treats both as "in flight"; completed/failed pass through.
    const mappedStatus = (() => {
      switch (row.status) {
        case "completed": return "completed";
        case "failed":
        case "canceled": return "failed";
        default:          return "processing";
      }
    })() as TranscodeJobRow["status"];

    return {
      id: row.id,
      instance_id: payload.instanceId ?? "",
      profile: payload.profileId ?? "",
      profile_id: payload.profileId ?? null,
      engine: "browser_pool",
      status: mappedStatus,
      output_instance_id: null,
      error_message: row.error_message,
      created_at: row.created_at,
      completed_at: null,
    };
  }

  // Best-effort cancel: only queued / claimed rows can be cancelled cleanly.
  // Completed/failed rows are left untouched. Mirrors /work/cancel semantics
  // but without the admin auth (the engine itself is trusted).
  async cancel(jobId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE work_queue
         SET status = 'canceled',
             error_message = COALESCE(error_message, 'canceled by engine')
       WHERE id = ? AND status IN ('queued','claimed')`,
    ).bind(jobId).run();
  }

  // No remote probe necessary — the engine is "alive" as long as the D1
  // binding is reachable, which the rest of the Worker already requires.
  async healthCheck(): Promise<boolean> {
    return true;
  }

  // -------------------------------------------------------------------------
  // Asynchronous entry point. Returns the work_queue id; the caller is
  // responsible for surfacing it to the client (HTTP JSON / Subsonic XML).
  // -------------------------------------------------------------------------
  async enqueueTranscodeTask(
    sourceUri: string,
    instanceId: string,
    profile: TranscodeProfile,
    uploadUrl: string,
  ): Promise<string> {
    const payload: TranscodePayload = {
      sourceUri,
      instanceId,
      profileId: profile.id,
      outputSuffix: profile.container,
      ffmpegArgs: buildFfmpegArgs(profile),
      uploadUrl,
    };
    return await dispatchWork(this.db, {
      taskType: "transcode",
      payload,
      requiredCaps: ["ffmpeg"],
      priority: 5,
    });
  }
}
