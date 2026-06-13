-- ============================================================================
-- 0019 [046 Feature] Podcast — channels + episodes + manage_podcasts permission
-- ============================================================================
-- Subsonic Podcast API (getPodcasts / getNewestPodcasts / getPodcastEpisode /
-- refreshPodcasts / createPodcastChannel / deletePodcastChannel /
-- deletePodcastEpisode / downloadPodcastEpisode). Cron Trigger refreshes RSS
-- hourly; downloads to R2 are opt-in per episode via ctx.waitUntil.
--
-- Status state machines:
--   podcast_channels.status: new → completed | error
--   podcast_episodes.status: new → downloading → completed | error
-- ============================================================================

CREATE TABLE IF NOT EXISTS podcast_channels (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'new',       -- new / completed / error
  error_message TEXT,
  last_refreshed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS podcast_episodes (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT,
  description TEXT,
  audio_url TEXT,
  published_at INTEGER,
  duration INTEGER,
  size INTEGER,
  bit_rate INTEGER,
  status TEXT NOT NULL DEFAULT 'new',       -- new / downloading / completed / error
  downloaded_r2_key TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (channel_id, guid),
  FOREIGN KEY (channel_id) REFERENCES podcast_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel_pub
  ON podcast_episodes (channel_id, published_at DESC);

-- ----------------------------------------------------------------------------
-- Permissions — level 3/2 manage podcasts; level 1/0 read-only via standard
-- auth. Idempotent so re-running the migration doesn't blow away admin tweaks.
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'manage_podcasts', 1, NULL),
  (2, 'manage_podcasts', 1, NULL),
  (1, 'manage_podcasts', 0, NULL),
  (0, 'manage_podcasts', 0, NULL);
