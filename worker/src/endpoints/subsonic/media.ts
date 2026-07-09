import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { parseStorageUri } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { urlAdapter } from "../../adapters/url";
import { createWebDAVAdapter } from "../../adapters/webdav";
import { createSubsonicAdapter } from "../../adapters/subsonic";
import type { StreamResult } from "../../adapters/index";
import { subsonicError } from "../../auth";
import { getFeature, getFeatureString, parseChain } from "../../utils/features";
// Transcode factory is statically imported (it lazy-loads the Sandbox /
// External engine modules so this is safe under tsx test runs). Tests can
// inject a FakeEngine via __setEngineFactoryForTest exported from factory.ts.
import { DEFAULT_PROFILES } from "../../transcode/profiles";
import { buildTranscodeEngine } from "../../transcode/factory";
import { BrowserPoolEngine } from "../../transcode/browser_pool";
import { signUploadToken } from "../../utils/workUploadToken";
import type { TranscodeProfile, TranscodeInput } from "../../transcode/engine";
import { presignR2Get } from "../../utils/r2presign";

import type { User } from "../../types/entities";

export const mediaRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User; authMethod: string; streamProxyStrategy?: string };
}>();

// ============================================================================
// 036 — Cover size cache.
//
// Workers has no Canvas API; bundling @cf-wasm/photon would add ~1.5 MB of
// cold-start cost for an end user benefit (sub-200 KB thumbnails) we can
// approximate cheaply. The strategy:
//   1. Validate `size` against an allow-list (only the values Subsonic
//      clients actually request — DSub/Substreamer/Sonixd hover around
//      64/128/256/512).
//   2. If unset / invalid → behave like the legacy endpoint and serve the
//      cached original at covers/<albumId>.
//   3. If valid → serve covers/<albumId>_s<size>. First request copies the
//      original into the sized slot (no real resize — fallback per
//      findings.md decision 1). Clients still get a cache-friendly URL with
//      a stable key per size; bandwidth optimisation is a follow-up.
// ============================================================================
const ALLOWED_COVER_SIZES = new Set([64, 96, 128, 192, 256, 384, 512]);

function parseCoverSize(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return ALLOWED_COVER_SIZES.has(n) ? n : null;
}

// ============================================================================
// 036 — Stream parameter helpers.
// ============================================================================

// Pick the best profile for a (format, maxBitRate) tuple. format is the codec
// family the client asked for; maxBitRate caps the bitrate. Returns null when
// no profile in the catalogue satisfies the constraints — caller falls back
// to the original instance.
function pickProfile(format: string, maxBitRate: number): TranscodeProfile | null {
  // Map Subsonic format values onto our container tags. Subsonic accepts
  // 'mp3' / 'opus' / 'oga' / 'ogg' / 'aac' / 'flac' here; clients also use the
  // codec name directly.
  const fmt = format.toLowerCase();
  let container: TranscodeProfile["container"] | null = null;
  switch (fmt) {
    case "mp3":          container = "mp3";  break;
    case "opus":         container = "opus"; break;
    case "ogg":
    case "oga":
    case "vorbis":       container = "ogg";  break;
    case "aac":
    case "m4a":          container = "m4a";  break;
    case "flac":         container = "flac"; break;
    default:             container = null;
  }
  if (!container) return null;

  // Filter the catalogue to the target container; further-narrow by bitrate
  // when the client capped it. We pick the highest bitrate at-or-below the
  // cap (best fidelity that still fits) — falling back to the lowest if every
  // profile is above the cap. Lossless flac is bitrate=0 so it ignores the
  // cap by construction.
  const candidates = DEFAULT_PROFILES.filter((p) => p.container === container);
  if (candidates.length === 0) return null;

  if (maxBitRate > 0 && container !== "flac") {
    const fits = candidates.filter((p) => p.bitrate <= maxBitRate);
    if (fits.length > 0) {
      // highest bitrate that still fits
      return fits.reduce((a, b) => (a.bitrate > b.bitrate ? a : b));
    }
    // every profile is above the cap → smallest one
    return candidates.reduce((a, b) => (a.bitrate < b.bitrate ? a : b));
  }

  // No cap → first by priority (catalogue is already sorted).
  return candidates[0];
}

// Open a streaming read of the chosen instance for transcoding. Unlike the
// happy-path stream this never honours Range — ffmpeg needs the whole file.
async function openSourceForTranscode(
  env: Env,
  storageUri: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  const parsed = parseStorageUri(storageUri);
  switch (parsed.scheme) {
    case "r2": {
      const r = await createR2Adapter(env.MUSIC_BUCKET).stream(storageUri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    case "url": {
      const r = await urlAdapter.stream(storageUri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    case "webdav": {
      const r = await createWebDAVAdapter(env.DB, env).stream(storageUri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    case "s3": {
      // 096 — S3-compatible proxy stream for transcoding
      const { getS3Config } = await import("../../adapters/index");
      const { createS3Adapter } = await import("../../adapters/s3");
      const config = await getS3Config(env.DB, parsed.sourceId);
      if (!config) return null;
      const r = await createS3Adapter(config).stream(storageUri);
      return r.body ? { body: r.body, contentType: r.contentType } : null;
    }
    default:
      // subsonic-upstream is intentionally excluded — we never re-transcode a
      // proxied stream (matches the policy in endpoints/transcode.ts).
      return null;
  }
}

// ============================================================================
// GET /rest/stream
// ----------------------------------------------------------------------------
// New query params (036):
//   format               — target codec/container; 'raw' to skip transcoding
//   maxBitRate           — kbps cap; triggers transcode when exceeded
//   timeOffset           — seconds; **accepted but not honoured** in v1 (the
//                          049 engine interface has no offset parameter).
//                          Response carries X-EdgeSonic-TimeOffset-Ignored:1
//                          so clients can fall back gracefully.
//   estimateContentLength — when 'true', emit a Content-Length header derived
//                          from duration_seconds × bit_rate × 125.
//
// If the engine is disabled or the picked profile is null → we serve the
// original instance instead of failing. The Subsonic spec calls this out as
// the correct behaviour ("ignored when the server doesn't support it").
// ============================================================================
const streamHandler = async (c: Context) => {
  const id = c.req.query("id");
  const format = c.req.query("format") || "raw";
  const maxBitRate = parseInt(c.req.query("maxBitRate") || "0", 10) || 0;
  const timeOffset = parseInt(c.req.query("timeOffset") || "0", 10) || 0;
  const estimateContentLength =
    (c.req.query("estimateContentLength") || "").toLowerCase() === "true";

  if (!id) return c.text(subsonicError(10, "Missing id parameter"), 400, { "Content-Type": "application/xml; charset=UTF-8" });
  const env = c.env as Env;

  const queries = createQueries(env.DB);
  // 056/058 hotfix: 052b worker pool 任务 payload 携带 song_instances.id (si- 前缀)
  // 而 Subsonic 标准 stream id = song_masters.id (sm- 前缀)。让 stream 端点宽容地
  // 接受 instance id：当 id 以 'si-' 开头时反查对应 master_id，再走标准路径。
  let resolvedId = id;
  if (id.startsWith("si-")) {
    const row = await env.DB.prepare(
      "SELECT master_id FROM song_instances WHERE id = ?"
    ).bind(id).first<{ master_id: string }>();
    if (row?.master_id) resolvedId = row.master_id;
  }
  const instances = await queries.getSongInstances(resolvedId);

  if (instances.length === 0) return c.text(subsonicError(70, "Song not found"), 404, { "Content-Type": "application/xml; charset=UTF-8" });

  let selected = instances[0];
  for (const inst of instances) {
    if (format !== "raw" && inst.suffix === format) { selected = inst; break; }
    if (inst.suffix === selected.suffix && (inst.bit_rate || 0) > (selected.bit_rate || 0)) selected = inst;
    if (inst.suffix === "flac" && selected.suffix !== "flac") selected = inst;
    // 093 — prefer R2 instances (Worker binding fast path + R2 presign
    // eligible). Pre-093 checked source_id === 'local' which never matched
    // the actual R2 source_id 'r2-local', so R2 copies were never preferred.
    if (inst.storage_uri.startsWith("r2://") && !selected.storage_uri.startsWith("r2://")) selected = inst;
    if (maxBitRate > 0 && (inst.bit_rate || 0) <= maxBitRate && (selected.bit_rate || 0) > maxBitRate) selected = inst;
  }

  // ---- Decide whether we need to transcode ---------------------------------
  // We transcode only when the chosen instance does not already satisfy the
  // request. format='raw' always skips. timeOffset alone does not trigger
  // transcoding (see findings.md decision 2 — we can't honour it anyway).
  const formatMismatch = format !== "raw" && selected.suffix !== format.toLowerCase();
  const bitRateMismatch = maxBitRate > 0 && (selected.bit_rate || 0) > maxBitRate;
  const needsTranscode = formatMismatch || bitRateMismatch;

  if (needsTranscode) {
    // 058 — Pre-baked instance short-circuit.
    // Before we ask the engine to do work, check whether the browser pool
    // (or any future pre-bake job) has already produced a song_instances
    // row matching the profile the client wants. When it has, we just
    // serve that instance verbatim — no engine call, no waitUntil.
    const targetProfile = pickProfile(format, maxBitRate);
    if (targetProfile) {
      const queries2 = createQueries(env.DB);
      const cached = await queries2.findTranscodedInstance(selected.master_id, targetProfile.id);
      if (cached) {
        selected = cached;
        // Fall through to the byte-stream block below — the cached row's
        // storage_uri is r2://cache/transcoded/... so the r2 adapter handles
        // it directly, identical to serving an original.
      } else {
    // 053 — Build a self-referential origin so the browser-pool engine can
    // hand its workers a same-origin /rest/stream URL to fetch from (the
    // session cookie carries through). Synthesise once here so both
    // browser_pool and any future engine that wants a raw URL share it.
    const reqUrl = new URL(c.req.url);
    const origin = `${reqUrl.protocol}//${reqUrl.host}`;
    // ExecutionContext access throws in test contexts that didn't pass one;
    // we treat its absence as "no pre-bake plumbing available" so the
    // browser_pool path just falls back to raw without trying to enqueue.
    let executionCtx: ExecutionContext<unknown> | null = null;
    // Hono's c.executionCtx type and the global ExecutionContext<unknown> (newer
    // @cloudflare/workers-types) differ only by the phantom `tracing` prop; the
    // runtime object has waitUntil, so a type-only cast is safe here.
    try { executionCtx = c.executionCtx as unknown as ExecutionContext<unknown>; } catch { executionCtx = null; }
    const transcoded = await tryTranscodeStream(
      env,
      selected.storage_uri,
      format,
      maxBitRate,
      timeOffset,
      estimateContentLength ? selected : null,
      // browser_pool needs these to enqueue a pre-bake job + sign the
      // upload URL; ignored by sandbox/external.
      executionCtx ? { instanceId: id, executionCtx, origin } : undefined,
    );
    if (transcoded) return transcoded;
    // engine disabled / no matching profile / source open failed / engine
    // is browser_pool (async-only) → fall back to the original byte stream.
      } // end else (no cached transcoded instance)
    } else {
      // pickProfile returned null → no profile in catalogue matches the
      // client's (format, maxBitRate). Same fallback as 053: serve raw.
    }
  }

  const parsed = parseStorageUri(selected.storage_uri);
  const range = c.req.header("Range") || undefined;
  let result: StreamResult;

  // 091/092 — Presigned URL short-circuit (R2 + WebDAV).
  //
  // When the chosen instance is on a presign-capable scheme AND the request
  // is raw (no transcode), try to 302 the browser to a direct-fetch URL so
  // bytes bypass the Worker sub-request bandwidth pool. Each scheme has its
  // own global feature flag; the credential's stream_proxy_strategy further
  // gates which schemes a given client credential is allowed to 302 on.
  //
  // Decision matrix:
  //   scheme   | flag            | strategy allows scheme | → 302?
  //   r2       | enable_r2_presign='1' + secrets set | always|r2_only      | yes
  //   r2       | off / secrets missing               | *                   | no (proxy)
  //   r2       | on                                  | never|webdav_only   | no (proxy)
  //   webdav   | enable_webdav_presign='1'           | always|webdav_only   | yes
  //   webdav   | off                                 | *                   | no (proxy)
  //   webdav   | on                                  | never|r2_only       | no (proxy)
  //
  // url/subsonic schemes never presign. Transcode branch never presigns.
  // Falls through to in-Worker stream on any failure / disabled path.
  if (!needsTranscode) {
    // 103 — WebDAV hot cache: schedule a background copy to R2 so the next
    // play of this master rides the r2:// fast path instead of the proxied
    // (bandwidth-pool-throttled) WebDAV stream. Fire-and-forget; dedupe and
    // rollback live in utils/hotcache.ts. Runs before the presign 302 so the
    // copy also happens for clients that get redirected.
    if (parsed.scheme === "webdav") {
      const hotcacheOn = await getFeatureString(env, "enable_webdav_hotcache", "0");
      if (hotcacheOn === "1") {
        try {
          const { hotCacheWebdav } = await import("../../utils/hotcache");
          hotCacheWebdav(env, selected, c.executionCtx as unknown as ExecutionContext<unknown>);
        } catch {
          // no ExecutionContext (tests) / import failure → play proceeds uncached
        }
      }
    }

    const strategy = (c.get("streamProxyStrategy") as string | undefined) || "always";
    // 093 — WebDAV UserInfo presign embeds credentials in the redirect URL
    // (user:password@host). Browsers block cross-origin redirects with
    // embedded userinfo (CORS policy: "Redirect location contains a username
    // and password, which is disallowed for cross-origin requests"), so the
    // WebDAV presign path is only safe for native Subsonic clients that
    // don't enforce that rule. Session auth = browser SPA → skip WebDAV
    // presign entirely; fall through to the in-Worker stream instead.
    const authMethod = (c.get("authMethod") as string | undefined) || "session";
    const isBrowserSession = authMethod === "session";

    if (parsed.scheme === "r2") {
      const presignOn = await getFeatureString(env, "enable_r2_presign", "0");
      const accessKeyId = env.R2_ACCESS_KEY_ID;
      const secretKey = env.R2_SECRET_ACCESS_KEY;
      const accountId = env.CF_ACCOUNT_ID;
      const schemeAllowed = strategy === "always" || strategy === "r2_only";
      if (presignOn === "1" && schemeAllowed && accessKeyId && secretKey && accountId) {
        try {
          const key = selected.storage_uri.substring("r2://".length);
          const presigned = await presignR2Get({
            bucket: "edgesonic-music",
            key,
            accessKeyId,
            secretAccessKey: secretKey,
            accountId,
            ttlSec: 300,
            rangeHeader: range,
          });
          // 093 — use Hono's c.redirect() (mutable Response) instead of
          // Response.redirect() (immutable headers — the COI middleware
          // after-next stamps headers and 500s on immutable). Also stop the
          // COI/CORP stamping entirely on presign redirects: the browser
          // follows the 302 to a cross-origin R2 S3 host where EdgeSonic's
          // same-origin CORP would be wrong anyway.
          //
          // 093b — Cache the 302 for the same TTL as the presigned URL so the
          // browser's <audio> Range follow-ups (seek, pre-buffer chunks) reuse
          // the cached redirect and skip the Worker entirely on subsequent
          // ranges. Without this, every Range request re-hit the Worker to
          // re-sign + 302, defeating the presign bandwidth-saving purpose.
          // The presigned URL itself is host-only signed, so any Range the
          // browser sends to it will be accepted by R2.
          const r = c.redirect(presigned, 302);
          r.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          r.headers.set("Cache-Control", "public, max-age=300");
          return r;
        } catch {
          // signing failure → fall through to in-Worker stream
        }
      }
    } else if (parsed.scheme === "webdav") {
      // Skip WebDAV presign for browser sessions — see isBrowserSession note above.
      if (isBrowserSession) {
        // fall through to in-Worker stream
      } else {
        // 108 — default OFF. The userinfo redirect (user:pass@host) is
        // rejected by ExoPlayer/AVFoundation/okhttp-based Subsonic clients
        // too, not just browsers — external players got a 302 they couldn't
        // follow and reported "unable to load media". It also hands the
        // WebDAV credentials to every streaming client. Admins with a
        // controlled client set can still re-enable via feature_strings
        // (migration 0035 flips existing '1' rows to '0').
        const presignOn = await getFeatureString(env, "enable_webdav_presign", "0");
        const schemeAllowed = strategy === "always" || strategy === "webdav_only";
        if (presignOn === "1" && schemeAllowed) {
          try {
            const adapter = createWebDAVAdapter(env.DB, env);
            const presigned = await adapter.presign(selected.storage_uri, range);
            if (presigned) {
              const r = c.redirect(presigned.url, 302);
              r.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
              return r;
            }
          } catch {
            // presign failure → fall through to in-Worker stream
          }
        }
      }
    }
  }

  switch (parsed.scheme) {
    case "r2":
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(selected.storage_uri, range);
      break;
    case "url":
      result = await urlAdapter.stream(selected.storage_uri, range);
      break;
    case "webdav":
      result = await createWebDAVAdapter(env.DB, env).stream(selected.storage_uri, range);
      break;
    case "s3": {
      // 096 — S3-compatible proxy stream (always proxied in v1; presign is v2)
      const { getS3Config } = await import("../../adapters/index");
      const { createS3Adapter } = await import("../../adapters/s3");
      const s3config = await getS3Config(env.DB, parsed.sourceId);
      if (!s3config) {
        return c.text(subsonicError(70, "S3 source not found or disabled"), 404, { "Content-Type": "application/xml; charset=UTF-8" });
      }
      result = await createS3Adapter(s3config).stream(selected.storage_uri, range);
      break;
    }
    case "subsonic": {
      if (!(await getFeature(env, "enable_subsonic_upstream"))) {
        return c.text(subsonicError(50, "Subsonic upstream sources are disabled"), 403, { "Content-Type": "application/xml; charset=UTF-8" });
      }
      const incomingChain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
      result = await createSubsonicAdapter(env.DB, {
        instanceId: env.INSTANCE_ID,
        incomingChain,
      }, env).stream(selected.storage_uri, range);
      break;
    }
    default:
      return c.text(subsonicError(0, "Unsupported storage scheme"), 500, { "Content-Type": "application/xml; charset=UTF-8" });
  }

  if (!result.body || result.statusCode >= 400) {
    return c.body(null, result.statusCode as never);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  if (result.contentLength) headers.set("Content-Length", String(result.contentLength));
  if (result.acceptRanges) headers.set("Accept-Ranges", "bytes");
  if (result.contentRange) headers.set("Content-Range", result.contentRange);

  return new Response(result.body, { status: result.statusCode, headers });
};

// Helper for the transcode branch above. Returns a Response on success, null
// on any fallback signal (engine disabled / unsupported profile / open fail).
async function tryTranscodeStream(
  env: Env,
  storageUri: string,
  format: string,
  maxBitRate: number,
  timeOffset: number,
  // Pass the instance only when the caller asked for Content-Length estimation
  // — keeps the calc opt-in and avoids broadcasting bit_rate noise.
  estimateInstance: { bit_rate: number | null; duration: number | null } | null,
  // 053 — Pre-bake context for engines that can't synchronously transcode
  // (browser_pool). When provided, an unsupported engine call falls back to
  // a queued pre-bake instead of straight raw.
  ctx?: { instanceId: string; executionCtx: ExecutionContext<unknown>; origin: string },
): Promise<Response | null> {
  const profile = pickProfile(format, maxBitRate);
  if (!profile) return null;

  const built = await buildTranscodeEngine(env);
  if (!built) return null;

  // 053 — Browser pool can't run inline; instead schedule a pre-bake task and
  // return null so the caller serves raw. The next identical request will
  // see the pre-baked instance once song_instances registration lands.
  if (built.kind === "browser_pool" && built.engine instanceof BrowserPoolEngine && ctx) {
    const engine = built.engine;
    ctx.executionCtx.waitUntil((async () => {
      try {
        const sourceUri = `${ctx.origin}/rest/stream?id=${encodeURIComponent(ctx.instanceId)}&format=raw`;
        const queueId = await engine.enqueueTranscodeTask(sourceUri, ctx.instanceId, profile, "PENDING_URL");
        const token = await signUploadToken(env, queueId);
        const uploadUrl = `${ctx.origin}/edgesonic/work/upload?id=${encodeURIComponent(queueId)}&token=${encodeURIComponent(token)}`;
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
      } catch {
        // pre-bake failure is non-fatal — the request still falls back to raw
      }
    })());
    return null;
  }

  const source = await openSourceForTranscode(env, storageUri);
  if (!source) return null;

  const input: TranscodeInput = { body: source.body, contentType: source.contentType };
  let out;
  try {
    out = await built.engine.transcode(input, profile);
  } catch {
    return null; // any engine failure → upstream caller falls back to raw
  }

  const headers = new Headers();
  headers.set("Content-Type", out.contentType);
  headers.set("Cache-Control", "no-store");
  headers.set("X-EdgeSonic-Engine", built.kind);
  headers.set("X-EdgeSonic-Transcoded", "1");
  headers.set("X-EdgeSonic-Profile", profile.id);

  if (timeOffset > 0) {
    // See findings.md decision 2. We accept the param so clients don't error
    // out, but the engine started the stream at t=0. The header lets advanced
    // clients log the discrepancy.
    headers.set("X-EdgeSonic-TimeOffset-Ignored", "1");
  }

  if (estimateInstance && (estimateInstance.duration || 0) > 0) {
    // kbps → bytes/sec is *1000/8 = *125. Use the *target* bitrate (the one
    // we're transcoding to) when known, otherwise fall back to the source
    // instance bitrate. Lossless flac (bitrate=0) skips the estimate.
    const bps = profile.bitrate > 0
      ? profile.bitrate * 125
      : (estimateInstance.bit_rate || 0) * 125;
    const estimated = Math.max(0, Math.floor((estimateInstance.duration || 0) * bps));
    if (estimated > 0) headers.set("Content-Length", String(estimated));
  }

  return new Response(out.body, { status: 200, headers });
}

// ============================================================================
// GET /rest/getCoverArt
// ----------------------------------------------------------------------------
// New query param (036):
//   size — numeric pixel hint (64 / 96 / 128 / 192 / 256 / 384 / 512). When
//          present and allowed, the cached R2 key becomes covers/<id>_s<size>
//          so different size requests stay separate in client caches. The
//          server does **not** actually resize the image (see findings.md
//          decision 1) — the underlying bytes are the original.
// ============================================================================
const getCoverArtHandler = async (c: Context) => {
  const id = c.req.query("id");
  if (!id) return c.body(null, 400 as never);

  const prefix = id.substring(0, 3);
  const entityId = id.substring(3);
  const queries = createQueries((c.env as Env).DB);
  const env = c.env as Env;

  const size = parseCoverSize(c.req.query("size"));

  let coverKey: string | null = null;
  if (prefix === "al-") {
    // Scan-era album ids already carry the "al-" prefix — try both forms
    let albumId = entityId;
    let album = await queries.getAlbum(albumId);
    if (!album) { albumId = id; album = await queries.getAlbum(albumId); }
    if (!album) return c.body(null, 404 as never);
    coverKey = album.cover_r2_key ?? null;
    // 102 — on-demand EMBEDDED-ART resolution. 076 dropped the on-demand path
    // entirely because its directory-image fallback assigned a shared parent
    // dir cover.jpg to every album under it; but mapAlbum/mapSong kept
    // advertising coverArt unconditionally, so every uncurated album 404'd.
    // covers.resolveAlbumCover is now embedded-only (APIC/FLAC PICTURE from
    // the album's own file — no cross-album hazard), so we can resolve+cache
    // lazily again. Albums without embedded art still 404 → placeholder.
    if (!coverKey) {
      const { resolveAlbumCover } = await import("../../utils/covers");
      try {
        coverKey = await resolveAlbumCover(env, albumId);
      } catch {
        coverKey = null; // source unreachable → behave as "no cover"
      }
    }
  } else if (prefix === "ar-") {
    const artist = await queries.getArtist(entityId);
    coverKey = artist?.image_r2_key ?? null;
  }

  if (!coverKey) return c.body(null, 404 as never);

  // ---- size handling ------------------------------------------------------
  // When a valid size was requested, serve from the sized cache key.
  // First request copies the original bytes into the sized slot (no resize).
  if (size) {
    const sizedKey = `${coverKey}_s${size}`;
    let sized = await env.MUSIC_BUCKET.get(sizedKey);
    if (!sized) {
      const original = await env.MUSIC_BUCKET.get(coverKey);
      if (!original) return c.body(null, 404 as never);
      // Buffer the original to a Uint8Array so we can both put() and respond
      // with a fresh stream. The body of an R2Object is consumable once.
      const buf = new Uint8Array(await original.arrayBuffer());
      const headers = new Headers();
      original.writeHttpMetadata(headers);
      await env.MUSIC_BUCKET.put(sizedKey, buf, {
        httpMetadata: { contentType: headers.get("Content-Type") || "image/jpeg" },
      });
      sized = await env.MUSIC_BUCKET.get(sizedKey);
      if (!sized) {
        // Put-but-no-get shouldn't happen; fall back to the original bytes
        // so we don't 500 on a transient bucket weirdness.
        const respHeaders = new Headers();
        original.writeHttpMetadata(respHeaders);
        respHeaders.set("X-EdgeSonic-Cover-Size", String(size));
        respHeaders.set("X-EdgeSonic-Cover-Cache", "miss");
        return new Response(buf, { headers: respHeaders });
      }
      const respHeaders = new Headers();
      sized.writeHttpMetadata(respHeaders);
      respHeaders.set("X-EdgeSonic-Cover-Size", String(size));
      respHeaders.set("X-EdgeSonic-Cover-Cache", "miss");
      return new Response(sized.body, { headers: respHeaders });
    }
    const headers = new Headers();
    sized.writeHttpMetadata(headers);
    headers.set("X-EdgeSonic-Cover-Size", String(size));
    headers.set("X-EdgeSonic-Cover-Cache", "hit");
    return new Response(sized.body, { headers });
  }

  // ---- legacy path (no size) ----------------------------------------------
  const object = await env.MUSIC_BUCKET.get(coverKey);
  if (!object) return c.body(null, 404 as never);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
};

// ============================================================================
// Route registration — Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    mediaRoutes.get(p, handler);
    mediaRoutes.post(p, handler);
  }
}

register("stream", streamHandler);
register("getCoverArt", getCoverArtHandler);
