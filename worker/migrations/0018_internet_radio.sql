-- ============================================================================
-- 0018: 045 — Internet Radio stations (Subsonic standard).
-- ============================================================================
-- Adds the `internet_radio_stations` table backing the 4 Subsonic endpoints:
--   /rest/getInternetRadioStations
--   /rest/createInternetRadioStation
--   /rest/updateInternetRadioStation
--   /rest/deleteInternetRadioStation
--
-- EdgeSonic acts as a station directory; the client connects to stream_url
-- directly (no proxy). Edit-side endpoints are admin-only via the new
-- `manage_radio` permission (mirrors `manage_sources` levels).
--
-- created_by FK is ON DELETE SET NULL so deleting a user keeps the station
-- alive — admin resources should not vanish with their author.
-- ============================================================================

CREATE TABLE IF NOT EXISTS internet_radio_stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  homepage_url TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (created_by) REFERENCES users(username) ON DELETE SET NULL
);

-- manage_radio permission (admin-only CUD). Levels match manage_sources defaults.
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (0, 'manage_radio', 0, 0),
  (1, 'manage_radio', 0, 0),
  (2, 'manage_radio', 1, 0),
  (3, 'manage_radio', 1, 0);
