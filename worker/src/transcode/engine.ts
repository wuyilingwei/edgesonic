//
// This module defines the contract that every transcoder backend must
// implement. Two backends ship with EdgeSonic:
//   - SandboxTranscodeEngine (worker/src/transcode/sandbox.ts) — runs ffmpeg
//     inside a Cloudflare Sandbox SDK container.
//   - ExternalTranscodeEngine (worker/src/transcode/external.ts) — proxies to
//     a self-hosted Node + Express + ffmpeg container (Fly.io / Hetzner / etc).
//
// Both backends consume the same TranscodeProfile catalogue (profiles.ts) and
// emit the same TranscodeJobRow status records (transcode_jobs table). The
// selection is driven by the `transcode_engine` feature string, so it is
// switchable at runtime from the Settings UI without redeploying.

export type TranscodeContainer = "mp3" | "m4a" | "opus" | "ogg" | "flac";
export type TranscodeStatus = "pending" | "processing" | "completed" | "failed";

// A single transcode target — codec + bitrate + container. The id is what the
// outside world (Settings UI, /rest/transcodeFile, transcode_jobs.profile_id)
// uses to refer to a profile; the rest is consumed only by the engines when
// building ffmpeg args.
export interface TranscodeProfile {
  id: string;          // e.g. 'mp3-128k'
  codec: string;       // ffmpeg -c:a codec, e.g. 'libmp3lame'
  bitrate: number;     // kbps; 0 for lossless
  container: TranscodeContainer;
  contentType: string; // e.g. 'audio/mpeg'
  priority: number;    // lower = preferred when multiple match
}

// What gets persisted in the transcode_jobs table after migration 0010 adds
// the engine / profile_id columns. Engines update this through the queries
// helper (insertTranscodeJob / updateTranscodeJob).
export interface TranscodeJobRow {
  id: string;
  instance_id: string;
  profile: string;             // legacy column (kept for back-compat)
  profile_id: string | null;   // new: stable profile reference
  engine: string | null;       // new: which backend ran the job
  status: TranscodeStatus;
  output_instance_id: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

// Engine input — either a binding-backed stream (R2 / WebDAV pull) or a
// pre-buffered Uint8Array. Engines decide whether to consume as a stream or
// a one-shot upload based on what they support.
export interface TranscodeInput {
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentType?: string;
  // Hint for engines that want to forward a Range request (none today, but
  // 036 will use this for partial transcodes when stream timeOffset is set).
  size?: number;
}

// Output from a successful transcode call. The body stream is consumable
// exactly once — wrap it in tee() if you need to fan-out to R2 + the client.
export interface TranscodeOutput {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  // Best-effort length hint. ffmpeg streaming output has no reliable
  // Content-Length, so this is usually undefined.
  size?: number;
}

// The contract every engine implements. Methods are intentionally narrow:
// the dispatcher (endpoints/transcode.ts) owns the transcode_jobs row, and
// the engine is responsible only for actually running ffmpeg.
export interface TranscodeEngine {
  // Name reported via getStatus / health endpoint — matches the feature
  // value (`sandbox` | `external`).
  readonly name: string;

  // Streaming transcode. Implementations should reject if the profile is
  // not in their supported list. The returned body should be ready for
  // pipe-through to the HTTP response (no buffering required).
  transcode(input: TranscodeInput, profile: TranscodeProfile): Promise<TranscodeOutput>;

  // Optional remote status check. Most engines have no out-of-band status
  // (the stream itself is the signal); they return the row from D1 here.
  getStatus(jobId: string): Promise<TranscodeJobRow | null>;

  // Best-effort cancellation. Local Sandbox engine can kill the container;
  // External engine sends a DELETE to /jobs/:id. Failure is silently logged.
  cancel(jobId: string): Promise<void>;

  // Liveness probe — used by Settings UI / future Cron to mark the engine
  // unreachable before pushing jobs at it. Should be cheap (< 1s).
  healthCheck(): Promise<boolean>;
}

// Engine selector — read from features.transcode_engine.
// executed by browser-resident Web Workers (52b). Async-only — callers must
// short-circuit on this kind instead of calling `engine.transcode()`.
export type EngineKind = "sandbox" | "external" | "browser_pool" | "disabled";

// Mode selector — read from features.transcode_mode.
//   on_demand : transcode at /stream time when no instance matches the request
//   pre_bake  : transcode on upload, write to song_instances as new rows
//   both      : pre-bake the default_profiles and fall back to on-demand
export type EngineMode = "on_demand" | "pre_bake" | "both";

// Sentinel returned from the dispatcher when the engine is disabled. Callers
// should fall back to the source instance unchanged.
export const ENGINE_DISABLED = Symbol("transcode-engine-disabled");
