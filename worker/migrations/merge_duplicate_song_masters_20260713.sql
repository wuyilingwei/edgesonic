-- One-off remote D1 cleanup for historical clone duplicates.
-- Strategy: merge sm-* song_masters into an existing legacy/non-sm canonical
-- when title/artist/album match after common metadata separator normalization
-- and duration differs by at most 3 seconds.

DROP TABLE IF EXISTS ops_song_master_merge_norm_20260713;
CREATE TABLE ops_song_master_merge_norm_20260713 AS
SELECT
  sm.id,
  sm.duration,
  lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(sm.title),' ',''),'　',''),',',''),'，',''),';',''),'；',''),'/',''),'、','')) AS title_key,
  lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(ar.name),' ',''),'　',''),',',''),'，',''),';',''),'；',''),'/',''),'、','')) AS artist_key,
  lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(al.name),' ',''),'　',''),',',''),'，',''),';',''),'；',''),'/',''),'、','')) AS album_key
FROM song_masters sm
JOIN artists ar ON ar.id = sm.artist_id
JOIN albums al ON al.id = sm.album_id;

DROP TABLE IF EXISTS ops_song_master_merge_map_20260713;
CREATE TABLE ops_song_master_merge_map_20260713 AS
SELECT duplicate_id, canonical_id
FROM (
  SELECT
    n1.id AS duplicate_id,
    (
      SELECT n2.id
      FROM ops_song_master_merge_norm_20260713 n2
      WHERE n2.id NOT LIKE 'sm-%'
        AND n2.title_key = n1.title_key
        AND n2.artist_key = n1.artist_key
        AND n2.album_key = n1.album_key
        AND (n1.duration IS NULL OR n2.duration IS NULL OR ABS(n1.duration - n2.duration) <= 3)
      ORDER BY n2.id
      LIMIT 1
    ) AS canonical_id
  FROM ops_song_master_merge_norm_20260713 n1
  WHERE n1.id LIKE 'sm-%'
)
WHERE canonical_id IS NOT NULL AND duplicate_id <> canonical_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_merge_map_dup_20260713
  ON ops_song_master_merge_map_20260713(duplicate_id);
CREATE INDEX IF NOT EXISTS idx_ops_merge_map_canon_20260713
  ON ops_song_master_merge_map_20260713(canonical_id);

CREATE TABLE IF NOT EXISTS ops_backup_song_masters_20260713 AS
SELECT * FROM song_masters
WHERE id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

CREATE TABLE IF NOT EXISTS ops_backup_song_instances_20260713 AS
SELECT * FROM song_instances
WHERE master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

CREATE TABLE IF NOT EXISTS ops_backup_annotations_20260713 AS
SELECT * FROM annotations
WHERE item_type = 'song'
  AND (item_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
       OR item_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713));

CREATE TABLE IF NOT EXISTS ops_backup_playlist_songs_20260713 AS
SELECT * FROM playlist_songs
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR song_master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

CREATE TABLE IF NOT EXISTS ops_backup_share_entries_20260713 AS
SELECT * FROM share_entries
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR song_master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

CREATE TABLE IF NOT EXISTS ops_backup_bookmarks_20260713 AS
SELECT * FROM bookmarks
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR song_master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

CREATE TABLE IF NOT EXISTS ops_backup_play_queues_20260713 AS
SELECT * FROM play_queues
WHERE current_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR EXISTS (
     SELECT 1 FROM json_each(play_queues.song_ids) je
     JOIN ops_song_master_merge_map_20260713 m ON je.value = m.duplicate_id
   );

CREATE TABLE IF NOT EXISTS ops_backup_scrape_jobs_20260713 AS
SELECT * FROM scrape_jobs
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
   OR song_master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

UPDATE song_masters
SET
  lyrics = COALESCE(lyrics, (SELECT d.lyrics FROM song_masters d JOIN ops_song_master_merge_map_20260713 m ON d.id = m.duplicate_id WHERE m.canonical_id = song_masters.id AND d.lyrics IS NOT NULL AND d.lyrics <> '' LIMIT 1)),
  genre = COALESCE(genre, (SELECT d.genre FROM song_masters d JOIN ops_song_master_merge_map_20260713 m ON d.id = m.duplicate_id WHERE m.canonical_id = song_masters.id AND d.genre IS NOT NULL AND d.genre <> '' LIMIT 1)),
  updated_at = unixepoch()
WHERE id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

UPDATE song_instances
SET master_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = song_instances.master_id),
    updated_at = unixepoch()
WHERE master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE annotations
SET
  play_count = COALESCE(play_count, 0) + COALESCE((
    SELECT SUM(COALESCE(d.play_count, 0))
    FROM annotations d
    JOIN ops_song_master_merge_map_20260713 m ON d.item_id = m.duplicate_id
    WHERE d.item_type = 'song'
      AND annotations.item_type = 'song'
      AND d.user_id = annotations.user_id
      AND m.canonical_id = annotations.item_id
  ), 0),
  play_date = max(COALESCE(play_date, 0), COALESCE((
    SELECT MAX(d.play_date)
    FROM annotations d
    JOIN ops_song_master_merge_map_20260713 m ON d.item_id = m.duplicate_id
    WHERE d.item_type = 'song'
      AND annotations.item_type = 'song'
      AND d.user_id = annotations.user_id
      AND m.canonical_id = annotations.item_id
  ), 0)),
  rating = COALESCE(rating, (
    SELECT MAX(d.rating)
    FROM annotations d
    JOIN ops_song_master_merge_map_20260713 m ON d.item_id = m.duplicate_id
    WHERE d.item_type = 'song'
      AND annotations.item_type = 'song'
      AND d.user_id = annotations.user_id
      AND m.canonical_id = annotations.item_id
  )),
  starred = max(COALESCE(starred, 0), COALESCE((
    SELECT MAX(d.starred)
    FROM annotations d
    JOIN ops_song_master_merge_map_20260713 m ON d.item_id = m.duplicate_id
    WHERE d.item_type = 'song'
      AND annotations.item_type = 'song'
      AND d.user_id = annotations.user_id
      AND m.canonical_id = annotations.item_id
  ), 0)),
  starred_at = max(COALESCE(starred_at, 0), COALESCE((
    SELECT MAX(d.starred_at)
    FROM annotations d
    JOIN ops_song_master_merge_map_20260713 m ON d.item_id = m.duplicate_id
    WHERE d.item_type = 'song'
      AND annotations.item_type = 'song'
      AND d.user_id = annotations.user_id
      AND m.canonical_id = annotations.item_id
  ), 0))
WHERE item_type = 'song'
  AND item_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

DELETE FROM annotations
WHERE item_type = 'song'
  AND item_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
  AND EXISTS (
    SELECT 1
    FROM annotations c
    JOIN ops_song_master_merge_map_20260713 m ON c.item_id = m.canonical_id
    WHERE m.duplicate_id = annotations.item_id
      AND c.item_type = 'song'
      AND c.user_id = annotations.user_id
  );

UPDATE annotations
SET item_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = annotations.item_id)
WHERE item_type = 'song'
  AND item_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE playlist_songs
SET song_master_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = playlist_songs.song_master_id)
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE share_entries
SET song_master_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = share_entries.song_master_id)
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE bookmarks
SET position_ms = max(position_ms, COALESCE((
      SELECT MAX(d.position_ms)
      FROM bookmarks d
      JOIN ops_song_master_merge_map_20260713 m ON d.song_master_id = m.duplicate_id
      WHERE d.user_id = bookmarks.user_id AND m.canonical_id = bookmarks.song_master_id
    ), 0)),
    comment = COALESCE(comment, (
      SELECT d.comment
      FROM bookmarks d
      JOIN ops_song_master_merge_map_20260713 m ON d.song_master_id = m.duplicate_id
      WHERE d.user_id = bookmarks.user_id AND m.canonical_id = bookmarks.song_master_id AND d.comment IS NOT NULL
      LIMIT 1
    )),
    updated_at = max(updated_at, COALESCE((
      SELECT MAX(d.updated_at)
      FROM bookmarks d
      JOIN ops_song_master_merge_map_20260713 m ON d.song_master_id = m.duplicate_id
      WHERE d.user_id = bookmarks.user_id AND m.canonical_id = bookmarks.song_master_id
    ), 0))
WHERE song_master_id IN (SELECT canonical_id FROM ops_song_master_merge_map_20260713);

DELETE FROM bookmarks
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)
  AND EXISTS (
    SELECT 1
    FROM bookmarks c
    JOIN ops_song_master_merge_map_20260713 m ON c.song_master_id = m.canonical_id
    WHERE m.duplicate_id = bookmarks.song_master_id
      AND c.user_id = bookmarks.user_id
  );

UPDATE bookmarks
SET song_master_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = bookmarks.song_master_id),
    updated_at = unixepoch()
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE scrape_jobs
SET song_master_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = scrape_jobs.song_master_id)
WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE clone_id_map
SET local_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = clone_id_map.local_id),
    updated_at = unixepoch()
WHERE item_type = 'song'
  AND local_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE play_queues
SET current_id = (SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = play_queues.current_id)
WHERE current_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE play_queues
SET song_ids = (
  SELECT json_group_array(value)
  FROM (
    SELECT COALESCE((SELECT canonical_id FROM ops_song_master_merge_map_20260713 WHERE duplicate_id = je.value), je.value) AS value
    FROM json_each(play_queues.song_ids) je
    ORDER BY CAST(je.key AS INTEGER)
  )
)
WHERE EXISTS (
  SELECT 1 FROM json_each(play_queues.song_ids) je
  JOIN ops_song_master_merge_map_20260713 m ON je.value = m.duplicate_id
);

DELETE FROM song_masters
WHERE id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713);

UPDATE albums
SET song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = albums.id),
    duration = (SELECT COALESCE(SUM(duration), 0) FROM song_masters WHERE album_id = albums.id),
    size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = albums.id),
    updated_at = unixepoch();

DELETE FROM albums
WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id);

DELETE FROM artists
WHERE NOT EXISTS (
  SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id
);

SELECT
  (SELECT COUNT(*) FROM ops_song_master_merge_map_20260713) AS merged_masters,
  (SELECT COUNT(*) FROM song_masters) AS song_masters_after,
  (SELECT COUNT(*) FROM song_instances WHERE master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)) AS dangling_instances,
  (SELECT COUNT(*) FROM playlist_songs WHERE song_master_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)) AS dangling_playlist_entries,
  (SELECT COUNT(*) FROM annotations WHERE item_type = 'song' AND item_id IN (SELECT duplicate_id FROM ops_song_master_merge_map_20260713)) AS dangling_song_annotations;
