-- 034 Playlists CRUD: add `comment` column, (owner, public) compound index,
-- and `manage_playlists` permission row for all levels.

ALTER TABLE playlists ADD COLUMN comment TEXT;

CREATE INDEX IF NOT EXISTS idx_playlists_owner_public ON playlists(owner, public);

-- manage_playlists: create/update/delete own playlists; admin (level=3) can delete others
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'manage_playlists', 1, 0),
  (2, 'manage_playlists', 1, 0),
  (1, 'manage_playlists', 1, 0),
  (0, 'manage_playlists', 0, 0);
