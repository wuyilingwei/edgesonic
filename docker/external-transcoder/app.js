//
// Express server with three routes:
//   GET    /health
//   POST   /transcode?profile=<id>   (raw audio body, streamed audio out)
//   GET    /status/:jobId            (in-memory job record, optional)
//   DELETE /jobs/:jobId              (kill running ffmpeg, optional)
//
// Auth: every non-/health request must send
//   X-EdgeSonic-Container-Key: <shared-secret>
// matching the SHARED_KEY env var. Reject anything else with 401.
//
// The profile catalogue is kept in lock-step with worker/src/transcode/profiles.ts.
// If you add a profile in the Worker, mirror it here.

import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || "8080", 10);
const SHARED_KEY = process.env.SHARED_KEY;

if (!SHARED_KEY) {
  console.error("FATAL: SHARED_KEY env var is required (generate with `openssl rand -hex 32`)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Profile catalogue (mirror of DEFAULT_PROFILES in the worker)
// ---------------------------------------------------------------------------
const PROFILES = {
  "mp3-128k":     { codec: "libmp3lame", bitrate: 128, container: "mp3",  contentType: "audio/mpeg" },
  "mp3-192k":     { codec: "libmp3lame", bitrate: 192, container: "mp3",  contentType: "audio/mpeg" },
  "aac-96k":      { codec: "aac",        bitrate: 96,  container: "m4a",  contentType: "audio/mp4" },
  "aac-128k":     { codec: "aac",        bitrate: 128, container: "m4a",  contentType: "audio/mp4" },
  "opus-64k":     { codec: "libopus",    bitrate: 64,  container: "opus", contentType: "audio/opus" },
  "opus-96k":     { codec: "libopus",    bitrate: 96,  container: "opus", contentType: "audio/opus" },
  "vorbis-96k":   { codec: "libvorbis",  bitrate: 96,  container: "ogg",  contentType: "audio/ogg" },
  "flac-lossless":{ codec: "flac",       bitrate: 0,   container: "flac", contentType: "audio/flac" },
};

function formatForContainer(c) {
  switch (c) {
    case "mp3":  return "mp3";
    case "m4a":  return "ipod";
    case "opus": return "opus";
    case "ogg":  return "ogg";
    case "flac": return "flac";
    default: throw new Error(`unknown container ${c}`);
  }
}

function buildFfmpegArgs(profile) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn", "-sn", "-dn",
    "-c:a", profile.codec,
  ];
  if (profile.bitrate > 0) args.push("-b:a", `${profile.bitrate}k`);
  args.push("-f", formatForContainer(profile.container), "pipe:1");
  return args;
}

// ---------------------------------------------------------------------------
// In-memory job tracker (optional — only useful for pre-bake)
// ---------------------------------------------------------------------------
/** @type {Map<string, {status: string, startedAt: number, endedAt: number|null, error: string|null, child: import("node:child_process").ChildProcess|null}>} */
const jobs = new Map();

function reapJob(jobId, status, error) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  job.endedAt = Date.now();
  job.error = error;
  job.child = null;
  // GC after 10 minutes to bound memory.
  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
});

function authGate(req, res, next) {
  if (req.get("X-EdgeSonic-Container-Key") !== SHARED_KEY) {
    return res.status(401).type("text/plain").send("unauthorized");
  }
  next();
}

app.post("/transcode", authGate, (req, res) => {
  const profileId = String(req.query.profile || "");
  const profile = PROFILES[profileId];
  if (!profile) {
    return res.status(400).type("text/plain").send(`unknown profile: ${profileId}`);
  }

  const jobId = String(req.query.jobId || randomUUID());
  const args = buildFfmpegArgs(profile);
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

  jobs.set(jobId, {
    status: "processing",
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    child: ff,
  });

  let stderrBuf = "";
  ff.stderr.on("data", (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-8192);
  });

  res.writeHead(200, {
    "Content-Type": profile.contentType,
    "Cache-Control": "no-store",
    "Transfer-Encoding": "chunked",
    "X-EdgeSonic-Job-Id": jobId,
  });

  req.pipe(ff.stdin);
  ff.stdout.pipe(res);

  ff.on("exit", (code) => {
    if (code === 0) {
      reapJob(jobId, "completed", null);
      return;
    }
    reapJob(jobId, "failed", stderrBuf.slice(-512));
    if (!res.writableEnded) {
      try { res.end(); } catch { /* ignore */ }
    }
  });

  req.on("close", () => {
    if (!ff.killed) ff.kill("SIGKILL");
    if (jobs.get(jobId)?.status === "processing") reapJob(jobId, "failed", "client closed");
  });
});

app.get("/status/:jobId", authGate, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "unknown" });
  res.json({
    id: req.params.jobId,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.endedAt,
    errorMessage: job.error,
  });
});

app.delete("/jobs/:jobId", authGate, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.child) return res.status(404).type("text/plain").send("not found");
  job.child.kill("SIGKILL");
  reapJob(req.params.jobId, "failed", "cancelled");
  res.type("text/plain").send("ok");
});

app.listen(PORT, () => {
  console.log(`edgesonic-external-transcoder listening on :${PORT}`);
});
