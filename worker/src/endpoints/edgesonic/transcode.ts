// 049 — Transcode endpoints.
//
// POST /rest/transcodeFile?id=<song>&profile=<id>
//   Manually trigger a transcode. Writes a transcode_jobs row, asks the
//   currently-selected engine to do the work, and streams the encoded
//   audio back. JobId returned via X-EdgeSonic-Job-Id header so the
//   caller can poll getTranscodeStatus afterwards.
//
// GET /rest/getTranscodeStatus?jobId=<id>
//   Returns the transcode_jobs row plus the engine name.
//
// The /stream endpoint integration (on-demand transcoding triggered by
// stream's format/maxBitRate parameters) is owned by task 036 and lives
// in media.ts; this file ships only the manual entry point.

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";
import type { TranscodeInput } from "../../transcode/engine";
import { getProfile } from "../../transcode/profiles";
import { buildTranscodeEngine } from "../../transcode/factory";
import { BrowserPoolEngine } from "../../transcode/browser_pool";
import { signUploadToken } from "../../utils/workUploadToken";
import { parseStorageUri } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { urlAdapter } from "../../adapters/url";
import { createWebDAVAdapter } from "../../adapters/webdav";

export const transcodeRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// Engine resolution lives in transcode/factory.ts (shared with media.ts so
// /rest/stream and /rest/transcodeFile cannot drift).

// Open a streaming read of the song's source instance. Returns null when no
// suitable instance is found. Mirrors the adapter dispatch in media.ts but
// stripped down: transcode never participates in proxy chains and never
// honours Range (ffmpeg consumes the whole file).
async function openSourceStream(env: Env, instanceId: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  const queries = createQueries(env.DB);
  const instances = await queries.getSongInstances(instanceId);
  if (instances.length === 0) return null;
  // Prefer a local R2 lossless instance; otherwise pick the first.
  const selected = instances.find((i) => i.suffix === "flac") ?? instances[0];

  const parsed = parseStorageUri(selected.storage_uri);
  switch (parsed.scheme) {
    case "r2": {
      const r = await createR2Adapter(env.MUSIC_BUCKET).stream(selected.storage_uri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    case "url": {
      const r = await urlAdapter.stream(selected.storage_uri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    case "webdav": {
      const r = await createWebDAVAdapter(env.DB).stream(selected.storage_uri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    default:
      // subsonic-upstream is intentionally excluded — we never re-transcode a
      // remote proxied stream (it would already be the upstream's choice).
      return null;
  }
}

// POST /rest/transcodeFile — manual trigger.
transcodeRoutes.post("/transcode/start", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  let body: { id?: string; profile?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text(subsonicError(0, "Invalid JSON body"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  if (!body.id || !body.profile) {
    return c.text(subsonicError(10, "Missing id or profile"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const profile = getProfile(body.profile);
  if (!profile) {
    return c.text(subsonicError(70, `Unknown profile: ${body.profile}`), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const built = await buildTranscodeEngine(env);
  if (!built) {
    return c.text(subsonicError(50, "Transcode engine is disabled or misconfigured"), 503, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const { engine, kind } = built;

  // 053 — Browser-pool engine is async-only: instead of opening the source
  // stream here and synchronously transcoding, we hand the source URI to
  // the browser worker via the work_queue. Tested in
  // test/browser_pool_engine.test.ts. The signed /stream URL the browser
  // will GET against carries the session cookie, so we just build a
  // self-referential same-origin URL the polling worker can hit.
  if (kind === "browser_pool" && engine instanceof BrowserPoolEngine) {
    const reqUrl = new URL(c.req.url);
    const origin = `${reqUrl.protocol}//${reqUrl.host}`;
    const sourceUri = `${origin}/rest/stream?id=${encodeURIComponent(body.id)}&format=raw`;

    // Reserve the queue id first so we can mint a token bound to it.
    // dispatchWork inside enqueueTranscodeTask reuses the same id format
    // (wq-xxx) — we mint here and pass the upload URL with that id.
    // We pre-mint by signing a placeholder; instead we ask the engine
    // for the queue id first, then patch a freshly-signed token onto a
    // second-step PATCH UPDATE — but D1 latency is cheap, do it in two
    // steps for simplicity:
    //   step 1: enqueue with a placeholder uploadUrl pointing to a token
    //           we will sign for the returned queue id
    //   step 2: re-write payload.uploadUrl now that we know the id.
    // We avoid step 2 by signing AFTER we know the id: we enqueue an empty
    // string, then UPDATE payload.uploadUrl with the signed token. That
    // keeps dispatchWork API unchanged.
    const queueId = await engine.enqueueTranscodeTask(sourceUri, body.id, profile, "PENDING_URL");
    const token = await signUploadToken(env, queueId);
    const uploadUrl = `${origin}/edgesonic/work/upload?id=${encodeURIComponent(queueId)}&token=${encodeURIComponent(token)}`;

    // Patch payload.uploadUrl in-place — small JSON, single D1 UPDATE.
    const patched = await env.DB.prepare(
      `SELECT payload FROM work_queue WHERE id = ?`,
    ).bind(queueId).first<{ payload: string }>();
    if (patched?.payload) {
      const obj = JSON.parse(patched.payload);
      obj.uploadUrl = uploadUrl;
      await env.DB.prepare(
        `UPDATE work_queue SET payload = ? WHERE id = ?`,
      ).bind(JSON.stringify(obj), queueId).run();
    }

    return c.json({
      ok: true,
      jobId: queueId,
      engine: kind,
      profile: profile.id,
      status: "queued",
    });
  }

  const source = await openSourceStream(env, body.id);
  if (!source) {
    return c.text(subsonicError(70, "Source instance not found or unsupported scheme"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  // Write the transcode_jobs row before kicking off the engine so polls can
  // observe a "processing" status even mid-flight.
  const jobId = "tj-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const queries = createQueries(env.DB);
  await queries.insertTranscodeJob({
    id: jobId,
    instanceId: body.id,
    profile: profile.id,
    profileId: profile.id,
    engine: kind,
    status: "processing",
  });

  let out;
  try {
    const input: TranscodeInput = { body: source.body, contentType: source.contentType };
    out = await engine.transcode(input, profile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await queries.updateTranscodeJob(jobId, {
      status: "failed",
      errorMessage: msg,
      completedAt: Math.floor(Date.now() / 1000),
    });
    return c.text(subsonicError(0, `transcode failed: ${msg}`), 500, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  // Mark completed lazily. ctx.waitUntil ensures the row is updated even after
  // the response starts streaming. We don't have an exact byte count.
  const exec = c.executionCtx;
  exec.waitUntil((async () => {
    await queries.updateTranscodeJob(jobId, {
      status: "completed",
      completedAt: Math.floor(Date.now() / 1000),
    });
  })());

  return new Response(out.body, {
    status: 200,
    headers: {
      "Content-Type": out.contentType,
      "Cache-Control": "no-store",
      "X-EdgeSonic-Job-Id": jobId,
      "X-EdgeSonic-Engine": kind,
    },
  });
});

// GET /rest/getTranscodeStatus — poll a job.
transcodeRoutes.get("/transcode/status", async (c) => {
  const jobId = c.req.query("jobId");
  if (!jobId) {
    return c.text(subsonicError(10, "Missing jobId"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const env = c.env as Env;
  const queries = createQueries(env.DB);
  const row = await queries.getTranscodeJob(jobId);
  if (!row) {
    return c.text(subsonicError(70, "Transcode job not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  return c.text(
    subsonicOK({
      transcodeJob: {
        _attributes: {
          id: row.id,
          instanceId: row.instance_id,
          profile: row.profile_id ?? row.profile,
          engine: row.engine ?? "",
          status: row.status,
          createdAt: String(row.created_at),
          completedAt: row.completed_at != null ? String(row.completed_at) : "",
          error: row.error_message ?? "",
        },
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});
