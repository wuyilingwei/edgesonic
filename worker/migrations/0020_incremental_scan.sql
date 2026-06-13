-- ============================================================================
-- 0020: Incremental scan support (task 051)
-- ============================================================================
-- WebDAV PROPFIND now records getetag + getlastmodified per remote file so a
-- follow-up scan can detect what changed without re-importing every entry.
-- The decision triple is (source_etag, source_last_modified, size); when all
-- three match an existing row we skip the UPSERT entirely. When any one
-- differs we update the metadata and reset tag_scanned=0 so the BROWSER READ
-- queue rescans the new bytes.
--
-- Feature flags:
--   scan_interval_hours    — WebDAV auto-scan cadence (0 = disabled, N hours)
--   scan_etag_check        — '0'|'1' toggle for the ETag/lastModified/size skip
--   scan_rescan_strategy   — 'auto'|'worker'|'browser' (router decides who reads
--                            tags when a file changes). Worker only does mp3/
--                            flac/wav so 'auto' is the safe default.
--   scan_browser_auto      — '0'|'1' decides whether Files.vue auto-drains the
--                            pending queue when the page is visible.
-- ============================================================================

ALTER TABLE song_instances ADD COLUMN source_etag TEXT;
ALTER TABLE song_instances ADD COLUMN source_last_modified INTEGER;

-- Partial index to make /storage/scan/pending O(matches) instead of full scan.
CREATE INDEX IF NOT EXISTS idx_si_pending_scan
  ON song_instances (source_id, tag_scanned) WHERE tag_scanned = 0;

INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('scan_interval_hours',  '1',    'WebDAV auto-scan interval in hours; 0 = disabled', unixepoch()),
  ('scan_etag_check',      '1',    'Skip unchanged files via ETag/lastModified/size when 1', unixepoch()),
  ('scan_rescan_strategy', 'auto', 'When a file changed: auto/worker/browser decides who re-reads tags', unixepoch()),
  ('scan_browser_auto',    '1',    'Files.vue auto-runs BROWSER READ for pending items when visible', unixepoch());
