import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { createSubsonicAdapter } from "../adapters/subsonic";
import type { StreamResult } from "../adapters/index";
import { subsonicError } from "../auth";
import { getFeature, parseChain } from "../utils/features";
// Transcode factory is statically imported (it lazy-loads the Sandbox /
// External engine modules so this is safe under tsx test runs). Tests can
// inject a FakeEngine via __setEngineFactoryForTest exported from factory.ts.
import { DEFAULT_PROFILES } from "../transcode/profiles";
import { buildTranscodeEngine } from "../transcode/factory";
import type { TranscodeProfile, TranscodeInput } from "../transcode/engine";

export const mediaRoutes = new Hono();

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
      const r = await createWebDAVAdapter(env.DB).stream(storageUri);
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
mediaRoutes.get("/rest/stream", async (c) => {
  const id = c.req.query("id");
  const format = c.req.query("format") || "raw";
  const maxBitRate = parseInt(c.req.query("maxBitRate") || "0", 10) || 0;
  const timeOffset = parseInt(c.req.query("timeOffset") || "0", 10) || 0;
  const estimateContentLength =
    (c.req.query("estimateContentLength") || "").toLowerCase() === "true";

  if (!id) return c.text(subsonicError(10, "Missing id parameter"), 400, { "Content-Type": "application/xml; charset=UTF-8" });
  const env = c.env as Env;

  const queries = createQueries(env.DB);
  const instances = await queries.getSongInstances(id);

  if (instances.length === 0) return c.text(subsonicError(70, "Song not found"), 404, { "Content-Type": "application/xml; charset=UTF-8" });

  let selected = instances[0];
  for (const inst of instances) {
    if (format !== "raw" && inst.suffix === format) { selected = inst; break; }
    if (inst.suffix === selected.suffix && (inst.bit_rate || 0) > (selected.bit_rate || 0)) selected = inst;
    if (inst.suffix === "flac" && selected.suffix !== "flac") selected = inst;
    if (inst.source_id === "local" && selected.source_id !== "local") selected = inst;
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
    const transcoded = await tryTranscodeStream(
      env,
      selected.storage_uri,
      format,
      maxBitRate,
      timeOffset,
      estimateContentLength ? selected : null,
    );
    if (transcoded) return transcoded;
    // engine disabled / no matching profile / source open failed → fall back
    // to the original byte stream below.
  }

  const parsed = parseStorageUri(selected.storage_uri);
  const range = c.req.header("Range") || undefined;
  let result: StreamResult;

  switch (parsed.scheme) {
    case "r2":
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(selected.storage_uri, range);
      break;
    case "url":
      result = await urlAdapter.stream(selected.storage_uri, range);
      break;
    case "webdav":
      result = await createWebDAVAdapter(env.DB).stream(selected.storage_uri, range);
      break;
    case "subsonic": {
      if (!(await getFeature(env, "enable_subsonic_upstream"))) {
        return c.text(subsonicError(50, "Subsonic upstream sources are disabled"), 403, { "Content-Type": "application/xml; charset=UTF-8" });
      }
      const incomingChain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
      result = await createSubsonicAdapter(env.DB, {
        instanceId: env.INSTANCE_ID,
        incomingChain,
      }).stream(selected.storage_uri, range);
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
});

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
): Promise<Response | null> {
  const profile = pickProfile(format, maxBitRate);
  if (!profile) return null;

  const built = await buildTranscodeEngine(env);
  if (!built) return null;

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
mediaRoutes.get("/rest/getCoverArt", async (c) => {
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
    if (!coverKey) {
      // On-demand: pull a directory image or embedded art from the source, cache in R2
      const noCover = await env.KV.get(`nocover:${albumId}`);
      if (noCover) return c.body(null, 404 as never);
      const { resolveAlbumCover } = await import("../utils/covers");
      try {
        coverKey = await resolveAlbumCover(env, albumId);
      } catch { coverKey = null; }
      if (!coverKey) {
        await env.KV.put(`nocover:${albumId}`, "1", { expirationTtl: 86400 });
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
});
