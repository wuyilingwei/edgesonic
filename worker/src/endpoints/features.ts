import { Hono } from "hono";
import { invalidateFeature, invalidateFeatureString } from "../utils/features";
import type { User } from "../types/entities";

// Feature flag management (DESIGN.md §3.3).
// Both endpoints are in SESSION_ONLY_PATHS — authMiddleware already guarantees
// a web-session credential. Responses are JSON (web extension face).
export const featuresRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

featuresRoutes.get("/rest/getFeatures", async (c) => {
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

featuresRoutes.post("/rest/updateFeature", async (c) => {
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
]);

// Per-key validation. Returns null on success, error message otherwise.
function validateFeatureString(key: string, value: string): string | null {
  switch (key) {
    case "transcode_engine":
      if (!["sandbox", "external", "disabled"].includes(value)) {
        return "transcode_engine must be sandbox|external|disabled";
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

featuresRoutes.post("/rest/updateFeatureString", async (c) => {
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
featuresRoutes.get("/rest/getExternalSecret", async (c) => {
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

featuresRoutes.post("/rest/setExternalSecret", async (c) => {
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
