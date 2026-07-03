import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { parseStorageUri } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { urlAdapter } from "../../adapters/url";
import { createWebDAVAdapter } from "../../adapters/webdav";
import { createSubsonicAdapter } from "../../adapters/subsonic";
import type { StreamResult } from "../../adapters/index";
import { subsonicError } from "../../auth";
import { getFeature, parseChain } from "../../utils/features";

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
// GET /rest/stream
// ----------------------------------------------------------------------------
// Query params:
//   format     — preferred codec/container hint used for instance selection
//   maxBitRate — kbps cap used for instance selection
// The server serves the best matching pre-existing instance directly.
// ============================================================================
mediaRoutes.get("/stream", async (c) => {
  const id = c.req.query("id");
  const format = c.req.query("format") || "raw";
  const maxBitRate = parseInt(c.req.query("maxBitRate") || "0", 10) || 0;

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
    if (inst.source_id === "local" && selected.source_id !== "local") selected = inst;
    if (maxBitRate > 0 && (inst.bit_rate || 0) <= maxBitRate && (selected.bit_rate || 0) > maxBitRate) selected = inst;
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
      result = await createWebDAVAdapter(env.DB, env).stream(selected.storage_uri, range);
      break;
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
});

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
mediaRoutes.get("/getCoverArt", async (c) => {
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
    // 076 — DO NOT fall back to song-instance-directory cover.jpg here. The
    // covers.resolveAlbumCover path used to look at the first song's parent
    // directory and pick any cover.jpg / folder.jpg / front.jpg — which means
    // every album sharing a parent dir (e.g. a NAS root with a generic
    // cover.jpg) ended up writing distinct covers/al-X keys whose R2 bytes
    // were the SAME image. The visible result: hundreds of albums showed the
    // same anime-character cover. We now strictly require an admin-curated
    // cover_r2_key; anything else returns 404 so the front-end placeholder
    // (♪ glyph) renders, which is the honest UX.
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
