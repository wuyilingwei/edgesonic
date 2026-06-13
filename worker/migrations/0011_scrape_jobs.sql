-- Migration 0011 (task 040) — metadata scrape audit table + feature defaults.
--
-- scrape_jobs is a write-only audit log: one row per
--   * /rest/scrapeMetadata proxy call    (status='fetched')
--   * /rest/submitScrapeResult write     (status='applied')
--   * either above when it errors        (status='failed', error_message set)
--
-- The result_json blob holds the source-specific raw JSON (or a normalised
-- ScrapeResult shape — see web/src/lib/scrape/types.ts). It is never authoritative
-- for song_masters / albums / artists — those are written by the existing
-- writeTags chain (037/039). 040's job is to provide an audit trail.

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  song_master_id TEXT,
  source TEXT NOT NULL,            -- 'netease' / 'qmusic' / 'kugou' ...
  query TEXT,
  remote_song_id TEXT,
  result_json TEXT,                -- ScrapeResult JSON (subset of upstream payload)
  status TEXT NOT NULL,            -- 'fetched' / 'applied' / 'failed'
  mode TEXT,                       -- 'tags' / 'cover' / 'both' (applied rows only)
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_user_created ON scrape_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_master ON scrape_jobs (song_master_id);

-- Feature defaults (049 feature_strings + boolean features).
-- scrape_enabled is a boolean toggle (features table).
-- scrape_enabled_sources is the priority-ordered list of enabled providers.
INSERT OR IGNORE INTO features (key, value, description, updated_at) VALUES
  ('scrape_enabled', 1, 'Master switch for metadata scraping', unixepoch());

INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('scrape_enabled_sources', '["netease","qmusic","kugou"]', 'Enabled scrape sources in priority order (JSON array)', unixepoch());
