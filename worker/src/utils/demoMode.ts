// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Demo mode helpers. Demo mode is engaged by setting `DEMO_MODE="1"` in the
// Worker's [vars] or as a secret. It locks down dangerous capabilities and
// schedules periodic resets so a public demo instance can't be bricked.

export const DEMO_DISABLED_PERMS = [
  "manage_cloudflare",
  "dispatch_work",
  "maintenance_cleanup",
  "maintenance_reclaim",
  "maintenance_reset",
  "delete",
  "manage_users",
  "manage_sources",
] as const;

const DEMO_DISABLED_PERM_SET = new Set<string>(DEMO_DISABLED_PERMS);

// Feature keys that cannot be mutated while demo mode is on. Anything that
// would let a visitor pivot the instance to a different storage backend,
// change transcoding strategy, or disable the worker pool is off-limits.
export const DEMO_LOCKED_FEATURE_KEYS = new Set<string>([
  "transcode_engine",
  "transcode_mode",
  "default_transcode_profiles",
  "external_transcoder_url",
  "enable_r2_presign",
  "enable_webdav_presign",
  "enable_cross_origin_isolation",
  "worker_pool_enabled",
  "worker_poll_interval_seconds",
  "worker_batch_size",
  "worker_claim_ttl_seconds",
  "worker_max_concurrent",
  "cache_tier_standard",
  "cache_tier_extended",
  "scan_interval_hours",
  "scan_etag_check",
  "scan_rescan_strategy",
  "scan_browser_auto",
  "metadata_recheck_interval_hours",
  "lrc_backfill_interval_hours",
  "artist_scrape_interval_hours",
  // Cumulative R2 storage ceiling — locked in demo so a visitor can't
  // lift the cap from the Settings UI.
  "r2_max_storage_bytes",
  // Default UI theme — locked in demo so the operator's chosen showcase
  // theme (e.g. sp-sky) can't be overridden from the Settings UI.
  "default_theme",
  // File-type gate — locked in demo so a visitor can't switch to
  // "allow all" and upload arbitrary payloads.
  "allow_all_file_types",
]);

export function isDemoMode(env: { DEMO_MODE?: string }): boolean {
  return (env.DEMO_MODE || "").trim() === "1";
}

export function isDemoDisabledPerm(permission: string): boolean {
  return DEMO_DISABLED_PERM_SET.has(permission);
}

export function isDemoLockedFeature(key: string): boolean {
  return DEMO_LOCKED_FEATURE_KEYS.has(key);
}

// Default per-upload ceiling for demo mode. Operators can override via
// DEMO_MAX_UPLOAD_BYTES. The non-demo ceiling stays at 256 MiB
// (see work_upload.ts).
export function demoMaxUploadBytes(env: { DEMO_MAX_UPLOAD_BYTES?: string }): number {
  const raw = parseInt(env.DEMO_MAX_UPLOAD_BYTES || "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 256 * 1024 * 1024);
  return 50 * 1024 * 1024; // 50 MiB default in demo
}

// Resolve the cumulative R2 storage ceiling. Resolution order:
//   1. env.R2_MAX_LIMIT (set via wrangler [vars] or secret)
//   2. D1 feature_strings row "r2_max_storage_bytes"
//   3. Default: 100 MiB in demo mode, 0 (disabled) in normal mode.
//
// In demo mode the "r2_max_storage_bytes" feature_strings row is locked
// against edits via DEMO_LOCKED_FEATURE_KEYS, so a visitor cannot lift the
// cap by editing settings. In normal mode the operator can adjust it from
// the Settings UI like any other feature_string.
export async function r2MaxStorageBytes(
  env: { R2_MAX_LIMIT?: string; DB: D1Database; DEMO_MODE?: string },
): Promise<number> {
  const envRaw = parseInt(env.R2_MAX_LIMIT || "", 10);
  if (Number.isFinite(envRaw) && envRaw >= 0) return envRaw;
  // Fall back to D1 feature_strings.
  try {
    const row = await env.DB
      .prepare("SELECT value FROM feature_strings WHERE key = ?")
      .bind("r2_max_storage_bytes")
      .first<{ value: string }>();
    if (row) {
      const d1Raw = parseInt(row.value, 10);
      if (Number.isFinite(d1Raw) && d1Raw >= 0) return d1Raw;
    }
  } catch {
    // feature_strings table may be absent on a fresh DB; fall through.
  }
  return isDemoMode(env) ? 100 * 1024 * 1024 : 0;
}

// Resolve the default UI theme id. Env var wins, then D1 feature_strings
// row "default_theme", then null (SPA falls back to "black").
export async function defaultTheme(env: { DEFAULT_THEME?: string; DB: D1Database }): Promise<string | null> {
  const envTheme = (env.DEFAULT_THEME || "").trim();
  if (envTheme) return envTheme;
  try {
    const row = await env.DB
      .prepare("SELECT value FROM feature_strings WHERE key = ?")
      .bind("default_theme")
      .first<{ value: string }>();
    if (row && row.value.trim()) return row.value.trim();
  } catch {
    // feature_strings table may be absent on a fresh DB.
  }
  return null;
}

// Resolve whether /files/upload accepts any file type. "1" = allow all,
// "0" = audio-only. Resolution: env.ALLOW_ALL_FILE_TYPES → D1
// feature_strings row "allow_all_file_types" → "0".
export async function allowAllFileTypes(env: { ALLOW_ALL_FILE_TYPES?: string; DB: D1Database }): Promise<boolean> {
  const envRaw = (env.ALLOW_ALL_FILE_TYPES || "").trim();
  if (envRaw === "1" || envRaw === "0") return envRaw === "1";
  try {
    const row = await env.DB
      .prepare("SELECT value FROM feature_strings WHERE key = ?")
      .bind("allow_all_file_types")
      .first<{ value: string }>();
    if (row) {
      const v = row.value.trim();
      if (v === "1" || v === "0") return v === "1";
    }
  } catch {
    // feature_strings table may be absent on a fresh DB.
  }
  return false;
}

// Audio file extensions accepted when allow_all_file_types is false.
export const AUDIO_SUFFIXES = new Set([
  "flac", "mp3", "m4a", "aac", "ogg", "opus", "wav",
  "mp4", "m4b", "aiff", "aif", "wma", "alac",
]);

export function isAudioSuffix(suffix: string): boolean {
  return AUDIO_SUFFIXES.has(suffix.toLowerCase());
}

// Sum the size of every object currently in the R2 bucket. Used by the
// upload guard to enforce r2MaxStorageBytes. R2 list returns up to 1000
// keys per page; loop until exhausted.
export async function demoR2TotalBytes(bucket: R2Bucket): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) total += obj.size;
    if (!listed.truncated) break;
    cursor = listed.cursor;
  } while (cursor);
  return total;
}

// R2 key prefixes that survive the periodic demo reset. Everything else
// under MUSIC_BUCKET is deleted every DEMO_RESET_CRON tick.
export const DEMO_R2_KEEP_PREFIXES = ["demo-library/", "avatars/"];

export function isDemoKeptR2Key(key: string): boolean {
  return DEMO_R2_KEEP_PREFIXES.some((p) => key.startsWith(p));
}