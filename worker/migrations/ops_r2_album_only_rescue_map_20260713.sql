-- One-off audit map for rescuing old clone-created R2 paths from
-- music/{artist}/{album}/{file} to music/{album}/{file}.
-- This file only creates backup/map tables; object moves are executed through
-- /storage/files/move so R2 and D1 stay consistent.

DROP TABLE IF EXISTS ops_r2_album_only_rescue_map_20260713;

CREATE TABLE ops_r2_album_only_rescue_map_20260713 AS
WITH candidates AS (
  SELECT DISTINCT
    si.storage_uri,
    substr(si.storage_uri, 6) AS source_key,
    substr(substr(si.storage_uri, 6), 7) AS after_music
  FROM song_instances si
  WHERE si.storage_uri LIKE 'r2://music/%'
    AND (LENGTH(substr(si.storage_uri, 6)) - LENGTH(REPLACE(substr(si.storage_uri, 6), '/', '')) + 1) = 4
), mapped AS (
  SELECT
    storage_uri,
    source_key,
    'music/' || substr(after_music, instr(after_music, '/') + 1) AS target_key
  FROM candidates
), target_counts AS (
  SELECT target_key, COUNT(*) AS c
  FROM mapped
  GROUP BY target_key
)
SELECT
  m.source_key,
  m.target_key,
  CASE
    WHEN tc.c > 1 THEN 'duplicate_target'
    WHEN EXISTS (
      SELECT 1 FROM song_instances si
      WHERE si.storage_uri = 'r2://' || m.target_key
        AND si.storage_uri <> m.storage_uri
    ) THEN 'target_exists'
    ELSE 'move'
  END AS action,
  0 AS moved,
  NULL AS moved_at,
  NULL AS error
FROM mapped m
JOIN target_counts tc ON tc.target_key = m.target_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_r2_album_only_rescue_source_20260713
  ON ops_r2_album_only_rescue_map_20260713(source_key);
CREATE INDEX IF NOT EXISTS idx_ops_r2_album_only_rescue_action_20260713
  ON ops_r2_album_only_rescue_map_20260713(action, moved);

CREATE TABLE IF NOT EXISTS ops_backup_song_instances_r2_album_only_20260713 AS
SELECT * FROM song_instances
WHERE storage_uri IN (
  SELECT 'r2://' || source_key FROM ops_r2_album_only_rescue_map_20260713
)
OR storage_uri IN (
  SELECT 'r2://' || target_key FROM ops_r2_album_only_rescue_map_20260713
);

SELECT action, COUNT(*) AS unique_sources
FROM ops_r2_album_only_rescue_map_20260713
GROUP BY action
ORDER BY action;
