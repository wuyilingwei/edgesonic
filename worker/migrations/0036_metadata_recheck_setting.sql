-- (dedupKey namespace "recheck:<instanceId>", dispatched at most once per
-- instance ever) for song_instances that either (A) the worker's embedded
-- tag parser could not read at all (tag_scanned=2 — unsupported container
-- format like m4a/ogg/opus/wma/ape/aiff/alac/dsf, or a genuinely broken
-- file; music-metadata in the browser can read the former), or (B) were
-- successfully scanned but are still missing lyrics/disc despite the album
-- already having a resolved cover (i.e. "mostly complete, worth a re-pass").
-- 0 disables the cron-driven check, mirroring scan_interval_hours' semantics.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('metadata_recheck_interval_hours', '24',
   'Hours between automatic browser-pool metadata re-checks for unsupported-format or lyrics/disc-incomplete songs (0=disabled)',
   unixepoch());
