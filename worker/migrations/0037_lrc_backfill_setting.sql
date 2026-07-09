-- 113 — periodic batch LRC sidecar backfill for the pre-existing library.
-- 094 wired fetchLrcSidecar/importLrcOnScan into scan.ts (only for brand-new
-- song_instances INSERTs) and lyrics.ts's getLyrics endpoint (only when a
-- client actually requests lyrics for that song). Neither path retroactively
-- checks songs that were scanned before 094 shipped or that nobody has ever
-- played, so a sibling .lrc file sitting right next to those tracks is never
-- looked at. This setting gates a cron tick that sweeps song_masters with
-- empty lyrics directly (no work_queue dispatch — a sidecar read is a small
-- R2/WebDAV GET the Worker does itself). 0 disables the cron-driven sweep,
-- mirroring metadata_recheck_interval_hours' semantics.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('lrc_backfill_interval_hours', '24',
   'Hours between automatic batch scans for sibling .lrc sidecar files on songs still missing lyrics (0=disabled)',
   unixepoch());
