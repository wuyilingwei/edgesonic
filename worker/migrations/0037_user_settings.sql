-- 110 — User-level settings (per-user key-value store).
-- Replaces the system-level lastfm_api_key feature_string with a per-user
-- setting so each user can configure their own Last.fm API key.
-- Also serves as a general per-user settings table for future use.
CREATE TABLE IF NOT EXISTS user_settings (
  username  TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, key)
);