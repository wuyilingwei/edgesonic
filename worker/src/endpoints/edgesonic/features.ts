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
import type { User } from "../../types/entities";

// Feature flag management (DESIGN.md §3.3).
// Both endpoints are in SESSION_ONLY_PATHS — authMiddleware already guarantees
// a web-session credential. Responses are JSON (web extension face).
export const featuresRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

featuresRoutes.get("/features/list", async (c) => {
  const user = c.get("user");
  if (user.level < 2) {
    return c.json({ ok: false, error: "Admin level required" }, 403);
  }
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
