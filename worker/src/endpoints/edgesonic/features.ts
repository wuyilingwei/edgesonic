import { Hono } from "hono";
import { invalidateFeature, invalidateFeatureString } from "../../utils/features";
import { permissionMiddleware } from "../../auth";
import type { User } from "../../types/entities";

// Feature flag management (DESIGN.md §3.3).
// Both endpoints are in SESSION_ONLY_PATHS — authMiddleware already guarantees
// a web-session credential. Responses are JSON (web extension face).
export const featuresRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// 087 — gated by manage_permissions (the same permission used by the write
// endpoints below). Pre-087 used a hardcoded `if (user.level < 2)` which
// violated the permission-model rule; the new check now flows through
// user_permissions.manage_permissions (L3=1, L2=0 by default — operators can
// flip L2 on via the Permissions UI without a code change).
featuresRoutes.get("/features/list", permissionMiddleware("manage_permissions"), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT key, value, description, updated_at FROM features ORDER BY key ASC"
  ).all<{ key: string; value: number; description: string | null; updated_at: number }>();

  // 049 — string-valued feature flags (transcode_engine, transcode_mode, etc).
  // Returned alongside the boolean flags so the Settings UI can render them in
  // the same Common section without a second round-trip.
  const strResult = await c.env.DB.prepare(
    "SELECT key, value, description, updated_at FROM feature_strings ORDER BY key ASC"
  ).all<{ key: string; value: string; description: string | null; updated_at: number }>();

  return c.json({
    ok: true,
    instanceId: c.env.INSTANCE_ID,
    features: result.results,
    featureStrings: strResult.results,
  });
});

featuresRoutes.post("/features/update", async (c) => {
  const user = c.get("user");
  const perm = await c.env.DB.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = 'manage_permissions'"
  )
    .bind(user.level)
    .first<{ enabled: number }>();
  if (!perm || !perm.enabled) {
    return c.json({ ok: false, error: "manage_permissions permission required" }, 403);
  }

  let body: { key?: string; value?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.key || (body.value !== 0 && body.value !== 1)) {
    return c.json({ ok: false, error: "Expected { key, value: 0|1 }" }, 400);
  }

  const result = await c.env.DB.prepare(
    "UPDATE features SET value = ?, updated_at = ? WHERE key = ?"
  )
    .bind(body.value, Math.floor(Date.now() / 1000), body.key)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: `Unknown feature: ${body.key}` }, 404);
  }

  await invalidateFeature(c.env, body.key);
  return c.json({ ok: true });
});

// 049 — Update a string-valued feature flag (transcode_engine, etc).
// Same authorisation as updateFeature (manage_permissions). The set of valid
// keys is constrained server-side so we never write into an unknown row.
const STRING_FEATURE_KEYS = new Set([
  "transcode_engine",
  "transcode_mode",
  "default_transcode_profiles",
  "external_transcoder_url",
  // 040 — priority-ordered list of enabled metadata scrape sources.
  "scrape_enabled_sources",
  // 043 — Last.fm public read API key (server-side). Empty disables the
  // getArtistInfo / getAlbumInfo / getSimilarSongs / getTopSongs proxies.
  "lastfm_api_key",
  // 051 — incremental scan + scheduled WebDAV refresh controls.
  "scan_interval_hours",
  "scan_etag_check",
  "scan_rescan_strategy",
  "scan_browser_auto",
  // 052 — browser worker pool kill-switch and tunables. All four are stored
  // as strings even though some look numeric, so they round-trip through the
  // same /features/updateString endpoint as the rest of feature_strings.
  "worker_pool_enabled",
  "worker_poll_interval_seconds",
  "worker_batch_size",
  "worker_claim_ttl_seconds",
  // 088 — concurrent Web Workers per browser. Bigger = faster queue drain but
  // higher fetch bandwidth and CPU on the participating browser. Clamped 1..8.
  "worker_max_concurrent",
    // 065 — Cross-Origin Isolation kill switch. When '1', the global response
    // middleware in index.ts stamps COOP/COEP/CORP headers so the browser flips
    // `crossOriginIsolated = true`, unlocking SharedArrayBuffer + ffmpeg.wasm
    // multi-thread in the work pool. '0' restores pre-065 behaviour.
    "enable_cross_origin_isolation",
    // 091 — R2 presigned URL short-circuit for /rest/stream raw+r2. When '1'
    // AND R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY secrets are set (plus
    // CF_ACCOUNT_ID reused from 054), the stream endpoint 302-redirects the
    // browser to a short-lived SigV4 R2 S3 URL so bytes bypass the Worker
    // sub-request bandwidth pool. '0' keeps the existing in-Worker stream path.
    "enable_r2_presign",
    // 092 — WebDAV presigned URL short-circuit. When '1' AND the chosen
    // credential's stream_proxy_strategy allows WebDAV 302, the stream
    // endpoint 302-redirects to a UserInfo-embedded WebDAV URL. Default '1'
    // (on) — WebDAV streams benefit more than R2 since there's no Worker
    // binding fast path. Per-credential strategy in subsonic_credentials
    // still gates which clients opt in.
    "enable_webdav_presign",
    // 103 — WebDAV play-through hot cache. When '1', a raw (non-transcode)
    // /rest/stream of a webdav:// instance schedules a background copy of the
    // whole file into R2 (cache/webdav/<masterId>.<suffix>) and registers a
    // source_type='cached' instance, so subsequent plays stream from R2
    // (Worker binding fast path / R2 presign 302) instead of the throttled
    // proxied WebDAV path. Default '0' — it consumes R2 storage.
    "enable_webdav_hotcache",
    // 110 — cadence (hours) for the cron-driven metadata re-check that
    // dispatches unsupported-format / lyrics-or-disc-incomplete song_instances
    // to the browser worker pool for a second music-metadata pass. 0=disabled.
    "metadata_recheck_interval_hours",
    // 101 — GB of R2 free tier allocated to EdgeSonic for stats.ts's monthly
    // cost estimate (migration 0033 seeds the row). Never added to this
    // allowlist, so /features/updateString 404'd on it ("Unknown feature")
    // even though the row exists and is read fine via getFeatureString.
    "r2_free_allocation_gb",
    // 113 — cadence (hours) for the cron-driven batch scan that backfills
    // song_masters.lyrics from a sibling .lrc file for songs that were never
    // caught by 094's scan-time/on-demand sidecar checks. 0=disabled.
    "lrc_backfill_interval_hours",
  ]);

// Per-key validation. Returns null on success, error message otherwise.
function validateFeatureString(key: string, value: string): string | null {
  switch (key) {
    case "transcode_engine":
      // 053 — `browser_pool` joins the enum. Engines that do not run ffmpeg
      // in-Worker (browser_pool here, sandbox/external before it) all coexist
      // behind the same string-valued flag so the Settings UI does not need
      // to know which backend physically runs the codec.
      if (!["sandbox", "external", "browser_pool", "disabled"].includes(value)) {
        return "transcode_engine must be sandbox|external|browser_pool|disabled";
      }
      return null;
    case "transcode_mode":
      if (!["on_demand", "pre_bake", "both"].includes(value)) {
        return "transcode_mode must be on_demand|pre_bake|both";
      }
      return null;
    case "default_transcode_profiles": {
      // Must be a JSON array of strings; we don't check ids vs. catalogue here
      // (profiles.ts parseProfileIdList silently drops unknown ids).
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
          return "default_transcode_profiles must be a JSON array of strings";
        }
      } catch {
        return "default_transcode_profiles must be valid JSON";
      }
      return null;
    }
    case "external_transcoder_url":
      if (value && !/^https?:\/\//.test(value)) return "external_transcoder_url must start with http:// or https://";
      return null;
    case "lastfm_api_key":
      // Empty string is explicitly allowed — that's how the admin turns the
      // feature off. Anything else is accepted verbatim (last.fm keys are
      // 32-char hex but we don't want to encode that format here).
      if (value.length > 128) return "lastfm_api_key is too long";
      return null;
    case "scan_interval_hours": {
      // Stored as a stringified non-negative integer in [0, 168] (one week).
      // 0 disables the cron-driven scan; anything bigger is the cadence in
      // hours. Reject empty / NaN / negative / >168 outright.
      if (!/^\d+$/.test(value)) return "scan_interval_hours must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 168) return "scan_interval_hours must be between 0 and 168";
      return null;
    }
    case "scan_etag_check":
    case "scan_browser_auto":
      if (value !== "0" && value !== "1") return `${key} must be '0' or '1'`;
      return null;
    case "scan_rescan_strategy":
      if (!["auto", "worker", "browser"].includes(value)) {
        return "scan_rescan_strategy must be auto|worker|browser";
      }
      return null;
    case "worker_pool_enabled":
      if (value !== "0" && value !== "1") return "worker_pool_enabled must be '0' or '1'";
      return null;
    case "enable_cross_origin_isolation":
      // 065 — only '0' or '1'. Mirrored shape on worker_pool_enabled.
      if (value !== "0" && value !== "1") return "enable_cross_origin_isolation must be '0' or '1'";
      return null;
    case "enable_r2_presign":
      // 091 — only '0' or '1'. Actual R2 S3 credentials live in Workers
      // Secrets (not D1); this flag only gates whether the stream endpoint
      // tries the presign path. When '1' but secrets are missing, the
      // stream endpoint silently falls back to the in-Worker stream.
      if (value !== "0" && value !== "1") return "enable_r2_presign must be '0' or '1'";
      return null;
    case "enable_webdav_presign":
      // 092 — only '0' or '1'. Mirrors enable_r2_presign shape.
      if (value !== "0" && value !== "1") return "enable_webdav_presign must be '0' or '1'";
      return null;
    case "enable_webdav_hotcache":
      // 103 — only '0' or '1'. Mirrors enable_webdav_presign shape.
      if (value !== "0" && value !== "1") return "enable_webdav_hotcache must be '0' or '1'";
      return null;
    case "metadata_recheck_interval_hours": {
      // 110 — same shape as scan_interval_hours: non-negative integer, 0-168.
      if (!/^\d+$/.test(value)) return "metadata_recheck_interval_hours must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 168) return "metadata_recheck_interval_hours must be between 0 and 168";
      return null;
    }
    case "r2_free_allocation_gb": {
      // 101 — GB of R2's free tier the admin allocates to EdgeSonic's cost
      // estimate. Positive integer; 1000 is a generous ceiling (Cloudflare's
      // published free tier is 10 GB, but self-hosters may have a paid plan
      // with a larger effective allowance).
      if (!/^\d+$/.test(value)) return "r2_free_allocation_gb must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 1000) return "r2_free_allocation_gb must be between 0 and 1000";
      return null;
    }
    case "lrc_backfill_interval_hours": {
      // 113 — same shape as metadata_recheck_interval_hours: non-negative
      // integer, 0-168 (one week).
      if (!/^\d+$/.test(value)) return "lrc_backfill_interval_hours must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 168) return "lrc_backfill_interval_hours must be between 0 and 168";
      return null;
    }
    case "worker_poll_interval_seconds": {
      // Stored as a stringified integer in [30, 3600]. Anything lower hammers
      // D1 / KV; anything higher means a job sits in the queue for an hour.
      if (!/^\d+$/.test(value)) return "worker_poll_interval_seconds must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 30 || n > 3600) return "worker_poll_interval_seconds must be between 30 and 3600";
      return null;
    }
    case "worker_batch_size": {
      // 1..20 — bigger batches mean a single browser monopolises rare-cap
      // tasks; smaller batches mean more polls per minute.
      if (!/^\d+$/.test(value)) return "worker_batch_size must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 1 || n > 20) return "worker_batch_size must be between 1 and 20";
      return null;
    }
    case "worker_claim_ttl_seconds": {
      // 15..600 — the reclaim sweep runs hourly so anything beyond 10 minutes
      // is effectively rounded up to the next cron tick.
      if (!/^\d+$/.test(value)) return "worker_claim_ttl_seconds must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 15 || n > 600) return "worker_claim_ttl_seconds must be between 15 and 600";
      return null;
    }
    case "worker_max_concurrent": {
      // 088 — 1..8. The lower bound preserves the pre-088 serial behaviour
      // when an operator wants to roll back; the upper bound caps the per-
      // browser fan-out so a single participating tab can't saturate the
      // queue endpoint or the user's downlink.
      if (!/^\d+$/.test(value)) return "worker_max_concurrent must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 1 || n > 8) return "worker_max_concurrent must be between 1 and 8";
      return null;
    }
    case "scrape_enabled_sources": {
      // JSON array of strings, each one a known scrape source.
      const allowed = new Set(["netease", "qmusic", "kugou", "kuwo", "migu"]);
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
          return "scrape_enabled_sources must be a JSON array of strings";
        }
        for (const v of parsed) {
          if (!allowed.has(v)) return `Unknown scrape source: ${v}`;
        }
      } catch {
        return "scrape_enabled_sources must be valid JSON";
      }
      return null;
    }
    default:
      return `Unknown string feature: ${key}`;
  }
}

featuresRoutes.post("/features/updateString", async (c) => {
  const user = c.get("user");
  const perm = await c.env.DB.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = 'manage_permissions'"
  ).bind(user.level).first<{ enabled: number }>();
  if (!perm || !perm.enabled) {
    return c.json({ ok: false, error: "manage_permissions permission required" }, 403);
  }

  let body: { key?: string; value?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.key || typeof body.value !== "string") {
    return c.json({ ok: false, error: "Expected { key, value: string }" }, 400);
  }
  if (!STRING_FEATURE_KEYS.has(body.key)) {
    return c.json({ ok: false, error: `Unknown feature: ${body.key}` }, 404);
  }
  const validation = validateFeatureString(body.key, body.value);
  if (validation) {
    return c.json({ ok: false, error: validation }, 400);
  }

  const result = await c.env.DB.prepare(
    "UPDATE feature_strings SET value = ?, updated_at = ? WHERE key = ?"
  ).bind(body.value, Math.floor(Date.now() / 1000), body.key).run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: `Unknown feature: ${body.key}` }, 404);
  }

  await invalidateFeatureString(c.env, body.key);
  return c.json({ ok: true });
});

// 049 — External transcoder shared secret. Admin-only (manage_permissions)
// because exposing it would let anyone POST raw audio to the container.
// GET returns only a "set/unset" boolean — the actual value never leaves
// the Worker except when the engine itself uses it for outbound requests.
featuresRoutes.get("/features/secrets/get", async (c) => {
  const user = c.get("user");
  const perm = await c.env.DB.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = 'manage_permissions'"
  ).bind(user.level).first<{ enabled: number }>();
  if (!perm || !perm.enabled) {
    return c.json({ ok: false, error: "manage_permissions permission required" }, 403);
  }
  const key = c.req.query("key") || "external_transcoder_key";
  const row = await c.env.DB.prepare(
    "SELECT value, updated_at FROM external_secrets WHERE key = ?"
  ).bind(key).first<{ value: string; updated_at: number }>();
  return c.json({
    ok: true,
    key,
    set: !!(row && row.value),
    updatedAt: row?.updated_at ?? 0,
  });
});

featuresRoutes.post("/features/secrets/set", async (c) => {
  const user = c.get("user");
  const perm = await c.env.DB.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = 'manage_permissions'"
  ).bind(user.level).first<{ enabled: number }>();
  if (!perm || !perm.enabled) {
    return c.json({ ok: false, error: "manage_permissions permission required" }, 403);
  }
  let body: { key?: string; value?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const key = body.key || "external_transcoder_key";
  if (typeof body.value !== "string") {
    return c.json({ ok: false, error: "value must be a string (use empty string to clear)" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO external_secrets (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, body.value, now).run();
  return c.json({ ok: true, key, set: !!body.value });
});
