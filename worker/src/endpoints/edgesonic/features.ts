// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { Hono } from "hono";
import { invalidateFeature, invalidateFeatureString } from "../../utils/features";
import { permissionMiddleware } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import { isDemoMode, isDemoLockedFeature } from "../../utils/demoMode";
import type { User } from "../../types/entities";

// System settings are gated on `manage_settings` (default L3, grantable to L2
// via the Permissions UI) rather than the never-grantable `manage_permissions`,
// so a super-admin can delegate settings without also handing over the
// permission matrix. hasPermission honours the env override → D1 precedence.
async function requireManageSettings(
  c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
): Promise<Response | null> {
  const user = c.get("user");
  if (!(await hasPermission(c.env, user, "manage_settings"))) {
    return c.json({ ok: false, error: "manage_settings permission required" }, 403);
  }
  return null;
}

// Feature flag management (DESIGN.md §3.3).
// Both endpoints are in SESSION_ONLY_PATHS — authMiddleware already guarantees
// a web-session credential. Responses are JSON (web extension face).
export const featuresRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// System settings read/write flows through user_permissions.manage_settings
// (L3=1, L2=0 by default — a super-admin can grant L2 via the Permissions UI
// without a code change).
featuresRoutes.get("/features/list", permissionMiddleware("manage_settings"), async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT key, value, description, updated_at FROM features ORDER BY key ASC"
  ).all<{ key: string; value: number; description: string | null; updated_at: number }>();

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
  const denied = await requireManageSettings(c);
  if (denied) return denied;

  let body: { key?: string; value?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.key || (body.value !== 0 && body.value !== 1)) {
    return c.json({ ok: false, error: "Expected { key, value: 0|1 }" }, 400);
  }
  if (isDemoMode(c.env) && isDemoLockedFeature(body.key)) {
    return c.json({ ok: false, error: "Feature is locked in demo mode" }, 403);
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

// Same authorisation as updateFeature (manage_settings). The set of valid
// keys is constrained server-side so we never write into an unknown row.
const STRING_FEATURE_KEYS = new Set([
  "transcode_engine",
  "transcode_mode",
  "default_transcode_profiles",
  "external_transcoder_url",
  "scrape_enabled_sources",
  // getArtistInfo / getAlbumInfo / getSimilarSongs / getTopSongs proxies.
  "lastfm_api_key",
  // 260 — full artist bio/cover source priority list: netease/qmusic/lastfm,
  // tried in array order, first enabled hit wins. A source not present in the
  // array is disabled. See utils/artistScrapeFallback.ts.
  "lastfm_fallback_sources",
  // 253 — cadence (hours) for the cron-driven batch backfill that scans
  // artists missing biography / cover. 0=disabled.
  "artist_scrape_interval_hours",
  "scan_interval_hours",
  "scan_etag_check",
  "scan_rescan_strategy",
  "scan_browser_auto",
  // as strings even though some look numeric, so they round-trip through the
  // same /features/updateString endpoint as the rest of feature_strings.
  "worker_pool_enabled",
  "worker_poll_interval_seconds",
  "worker_batch_size",
  "worker_claim_ttl_seconds",
  // higher fetch bandwidth and CPU on the participating browser. Clamped 1..8.
  "worker_max_concurrent",
    // middleware in index.ts stamps COOP/COEP/CORP headers so the browser flips
    // `crossOriginIsolated = true`, unlocking SharedArrayBuffer + ffmpeg.wasm
    // multi-thread in the work pool. '0' restores pre-065 behaviour.
    "enable_cross_origin_isolation",
    // AND R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY secrets are set (plus
    // CF_ACCOUNT_ID reused from 054), the stream endpoint 302-redirects the
    // browser to a short-lived SigV4 R2 S3 URL so bytes bypass the Worker
    // sub-request bandwidth pool. '0' keeps the existing in-Worker stream path.
    "enable_r2_presign",
    // credential's stream_proxy_strategy allows WebDAV 302, the stream
    // endpoint 302-redirects to a UserInfo-embedded WebDAV URL. Default '1'
    // (on) — WebDAV streams benefit more than R2 since there's no Worker
    // binding fast path. Per-credential strategy in subsonic_credentials
    // still gates which clients opt in.
    "enable_webdav_presign",
    // replaced the old single global enable_webdav_hotcache boolean.
    // /rest/stream of a webdav:// instance schedules a background copy into
    // R2 when the source's storage_sources.cache_tier is 'standard' or
    // 'extended' (per-source opt-in, not a server-wide switch anymore). These
    // two JSON-valued flags hold each tier's {budgetMb,maxFileMb,ttlDays}.
    "cache_tier_standard",
    "cache_tier_extended",
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
    // Cumulative R2 storage ceiling in bytes (0 = disabled). Editable in
    // normal mode; locked in demo mode via DEMO_LOCKED_FEATURE_KEYS.
    "r2_max_storage_bytes",
    // Default UI theme id. Editable in normal mode; locked in demo mode.
    "default_theme",
    // Whether /files/upload accepts any file type ("1") or only audio
    // extensions ("0"). Editable in normal mode; locked in demo mode.
    "allow_all_file_types",
  ]);

// Per-key validation. Returns null on success, error message otherwise.
function validateFeatureString(key: string, value: string): string | null {
  switch (key) {
    case "transcode_engine":
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
      // Must be a JSON array of strings. Profile ids are validated when used.
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
    case "lastfm_fallback_sources": {
      // JSON array of artist-info source ids, in priority order. Allowed:
      // netease, qmusic, lastfm. Empty array disables all three. A source
      // missing from the array is simply not tried — this is the whole
      // priority list now, not just a "when last.fm fails" fallback.
      const allowed = new Set(["netease", "qmusic", "lastfm"]);
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
          return "lastfm_fallback_sources must be a JSON array of strings";
        }
        for (const v of parsed) {
          if (!allowed.has(v)) return `Unknown artist info source: ${v}`;
        }
      } catch {
        return "lastfm_fallback_sources must be valid JSON";
      }
      return null;
    }
    case "artist_scrape_interval_hours": {
      if (!/^\d+$/.test(value)) return "artist_scrape_interval_hours must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 168) return "artist_scrape_interval_hours must be between 0 and 168";
      return null;
    }
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
      if (value !== "0" && value !== "1") return "enable_cross_origin_isolation must be '0' or '1'";
      return null;
    case "enable_r2_presign":
      // Secrets (not D1); this flag only gates whether the stream endpoint
      // tries the presign path. When '1' but secrets are missing, the
      // stream endpoint silently falls back to the in-Worker stream.
      if (value !== "0" && value !== "1") return "enable_r2_presign must be '0' or '1'";
      return null;
    case "enable_webdav_presign":
      if (value !== "0" && value !== "1") return "enable_webdav_presign must be '0' or '1'";
      return null;
    case "cache_tier_standard":
    case "cache_tier_extended": {
      // JSON {"budgetMb":N,"maxFileMb":N,"ttlDays":N}, all positive integers.
      // Upper bounds are generous ceilings, not recommendations — 'extended'
      // is explicitly the "bigger, admin decides how big" tier.
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return `${key} must be valid JSON`;
      }
      if (typeof parsed !== "object" || parsed === null) return `${key} must be a JSON object`;
      const obj = parsed as Record<string, unknown>;
      for (const field of ["budgetMb", "maxFileMb", "ttlDays"] as const) {
        const n = obj[field];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1_000_000) {
          return `${key}.${field} must be a non-negative integer`;
        }
      }
      return null;
    }
    case "metadata_recheck_interval_hours": {
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
    case "r2_max_storage_bytes": {
      // Cumulative R2 storage ceiling in bytes. 0 disables the guard.
      if (!/^\d+$/.test(value)) return "r2_max_storage_bytes must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 0 || n > 1_000_000_000_000) return "r2_max_storage_bytes must be between 0 and 1TB";
      return null;
    }
    case "default_theme": {
      // Any non-empty string ≤64 chars is accepted; the actual theme id
      // validity is enforced client-side (the SPA ignores unknown ids).
      if (value.length > 64) return "default_theme too long (max 64 chars)";
      return null;
    }
    case "allow_all_file_types": {
      if (value !== "0" && value !== "1") return "allow_all_file_types must be '0' or '1'";
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
      // tasks; smaller batches mean more polls per minute.
      if (!/^\d+$/.test(value)) return "worker_batch_size must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 1 || n > 20) return "worker_batch_size must be between 1 and 20";
      return null;
    }
    case "worker_claim_ttl_seconds": {
      // is effectively rounded up to the next cron tick.
      if (!/^\d+$/.test(value)) return "worker_claim_ttl_seconds must be a non-negative integer";
      const n = parseInt(value, 10);
      if (n < 15 || n > 600) return "worker_claim_ttl_seconds must be between 15 and 600";
      return null;
    }
    case "worker_max_concurrent": {
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
  const denied = await requireManageSettings(c);
  if (denied) return denied;

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
  if (isDemoMode(c.env) && isDemoLockedFeature(body.key)) {
    return c.json({ ok: false, error: "Feature is locked in demo mode" }, 403);
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

// because exposing it would let anyone POST raw audio to the container.
// GET returns only a "set/unset" boolean — the actual value never leaves
// the Worker except when the engine itself uses it for outbound requests.
featuresRoutes.get("/features/secrets/get", async (c) => {
  const denied = await requireManageSettings(c);
  if (denied) return denied;
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
  const denied = await requireManageSettings(c);
  if (denied) return denied;
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
