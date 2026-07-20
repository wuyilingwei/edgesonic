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

// R2 key prefixes that survive the periodic demo reset. Everything else
// under MUSIC_BUCKET is deleted every DEMO_RESET_CRON tick.
export const DEMO_R2_KEEP_PREFIXES = ["demo-library/", "avatars/"];

export function isDemoKeptR2Key(key: string): boolean {
  return DEMO_R2_KEEP_PREFIXES.some((p) => key.startsWith(p));
}