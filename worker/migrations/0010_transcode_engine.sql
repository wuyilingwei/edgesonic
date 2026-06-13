-- ============================================================================
-- 0010: 049 — Transcode engine abstraction (SandboxTranscodeEngine /
--               ExternalTranscodeEngine + Settings switches).
-- ============================================================================
-- Three changes:
--   1. Extend transcode_jobs with engine + profile_id columns so every job
--      records which backend ran it (sandbox|external) and which profile
--      catalogue entry it targeted.
--   2. New table `feature_strings` for string-valued / JSON-valued feature
--      flags (engine, mode, default_profiles JSON, external URL). The
--      existing `features` table is integer-typed and can't hold strings.
--   3. New table `external_secrets` for high-trust opaque values (the
--      external transcoder shared key). Read/written only by admin-gated
--      endpoints, never exposed via getFeatures.
-- ============================================================================

-- --- transcode_jobs columns ---------------------------------------------------
-- SQLite supports ALTER TABLE ADD COLUMN. Existing rows get NULL.
ALTER TABLE transcode_jobs ADD COLUMN engine TEXT;
ALTER TABLE transcode_jobs ADD COLUMN profile_id TEXT;

-- --- feature_strings ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_strings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at  INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('transcode_engine',           'disabled', '转码引擎 (sandbox|external|disabled)'),
  ('transcode_mode',             'on_demand', '转码触发模式 (on_demand|pre_bake|both)'),
  ('default_transcode_profiles', '[]',        '默认预生成档位 JSON 数组（profile id 列表）'),
  ('external_transcoder_url',    '',          '外部转码器 URL（仅在 engine=external 时生效）');

-- --- external_secrets ---------------------------------------------------------
-- Stored as plain TEXT for now; 013 will move this into encrypted storage
-- alongside storage_sources.password (same threat model).
CREATE TABLE IF NOT EXISTS external_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER DEFAULT (unixepoch())
);

-- A single empty placeholder so admin UI can GET it without 404.
INSERT OR IGNORE INTO external_secrets (key, value) VALUES
  ('external_transcoder_key', '');
