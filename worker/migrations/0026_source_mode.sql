-- 089 S2 — Add `mode` column to storage_sources.
--
-- Allowed values:
--   'library'   (default) — source is scanned and files are entered into the
--                           media library (artists / albums / song_masters /
--                           song_instances rows written on each scan).
--   'sync_only'           — source participates in scans (last_sync is updated)
--                           but discovered files are NOT inserted into the
--                           library. The source is usable as a copy/sync
--                           destination via the crossCopy endpoint without
--                           polluting the library with untagged files.
--
-- The DEFAULT 'library' keeps all pre-existing rows behaving exactly as before.

ALTER TABLE storage_sources ADD COLUMN mode TEXT NOT NULL DEFAULT 'library';
