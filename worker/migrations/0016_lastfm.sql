-- ============================================================================
-- 0014: 043 — Last.fm public read API key feature flag.
-- ============================================================================
-- The proxy itself lives in worker/src/lib/lastfm.ts and is keyed off the
-- feature_strings.lastfm_api_key row. Empty value (the default) keeps the
-- four /rest/getXxxInfo* endpoints quiet: they return Subsonic error code 30
-- ("not supported") so the rest of the API stays available.
--
-- Idempotent: INSERT OR IGNORE so re-running the migration is safe even after
-- the admin has rotated the key through the Settings UI.
-- ============================================================================

INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('lastfm_api_key', '', 'Last.fm API key (optional, enables getArtistInfo/getSimilarSongs/getTopSongs proxies)');
