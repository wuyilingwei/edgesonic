-- 096: Add 's3' storage source type + region column
--
-- SQLite cannot ALTER TABLE to modify CHECK constraints, so we rebuild the
-- table. The INSERT…SELECT backfills region='us-east-1' for every existing row.
-- All indexes are recreated after the rename.

PRAGMA foreign_keys=OFF;

CREATE TABLE storage_sources_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webdav', 'subsonic', 'r2', 'url', 's3')),
  name TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  password_encrypted TEXT,
  root_path TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'us-east-1',
  last_sync INTEGER,
  enabled INTEGER DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'library',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

INSERT INTO storage_sources_new
  SELECT id, type, name, base_url, username, password, password_encrypted,
         root_path, 'us-east-1', last_sync, enabled, mode, created_at, updated_at
  FROM storage_sources;

DROP TABLE storage_sources;
ALTER TABLE storage_sources_new RENAME TO storage_sources;

CREATE INDEX IF NOT EXISTS idx_sources_enc ON storage_sources (id) WHERE password_encrypted IS NOT NULL;

PRAGMA foreign_keys=ON;
