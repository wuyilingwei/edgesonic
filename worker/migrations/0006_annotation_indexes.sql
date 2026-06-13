-- ============================================================================
-- 0006: Annotation endpoint support (task 033)
-- ============================================================================
-- Adds covering indexes for getStarred / setRating lookups and registers the
-- `edit_annotations` permission slot in user_permissions.

-- Index for getStarred / getStarred2 (per user, by item type, where starred=1)
CREATE INDEX IF NOT EXISTS idx_annotations_starred
  ON annotations(user_id, item_type, starred);

-- Index for rating-based lookups (e.g. top rated lists)
CREATE INDEX IF NOT EXISTS idx_annotations_rating
  ON annotations(user_id, item_type, rating);

-- Index for play_date-based ordering (e.g. recently played)
CREATE INDEX IF NOT EXISTS idx_annotations_played
  ON annotations(user_id, item_type, play_date);

-- New permission: edit_annotations (star / unstar / setRating / scrobble)
-- Levels follow existing pattern: 0 (guest) off, 1-3 on.
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (0, 'edit_annotations', 0, 0),
  (1, 'edit_annotations', 1, 0),
  (2, 'edit_annotations', 1, 0),
  (3, 'edit_annotations', 1, 0);
