-- EdgeSonic Initial Schema v2
-- Migration: 0001

CREATE TABLE storage_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  last_sync INTEGER,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  image_r2_key TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_artists_name ON artists(name);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  genre TEXT,
  cover_r2_key TEXT,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  compilation INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_albums_name ON albums(name);

CREATE TABLE song_masters (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  album_artist_id TEXT,
  title TEXT NOT NULL,
  sort_title TEXT,
  track INTEGER,
  disc INTEGER,
  duration INTEGER,
  genre TEXT,
  compilation INTEGER DEFAULT 0,
  participants TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (album_id) REFERENCES albums(id),
  FOREIGN KEY (artist_id) REFERENCES artists(id),
  FOREIGN KEY (album_artist_id) REFERENCES artists(id)
);
CREATE INDEX idx_songmasters_album ON song_masters(album_id);
CREATE INDEX idx_songmasters_artist ON song_masters(artist_id);
CREATE INDEX idx_songmasters_title ON song_masters(title);

CREATE TABLE song_instances (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  original_id TEXT,
  storage_uri TEXT NOT NULL,
  instance_type INTEGER DEFAULT 0,
  suffix TEXT NOT NULL,
  content_type TEXT,
  bit_rate INTEGER,
  sample_rate INTEGER,
  bit_depth INTEGER,
  channels INTEGER,
  duration INTEGER,
  size INTEGER,
  missing INTEGER DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (master_id) REFERENCES song_masters(id)
);
CREATE INDEX idx_instances_master ON song_instances(master_id);
CREATE INDEX idx_instances_source ON song_instances(source_id);
CREATE INDEX idx_instances_original ON song_instances(original_id);
CREATE INDEX idx_instances_expires ON song_instances(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE annotations (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  play_count INTEGER DEFAULT 0,
  play_date INTEGER,
  rating INTEGER,
  starred INTEGER DEFAULT 0,
  starred_at INTEGER,
  PRIMARY KEY (user_id, item_id, item_type)
);

CREATE TABLE users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  level INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE user_permissions (
  level INTEGER NOT NULL,
  permission TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  max_rph INTEGER DEFAULT 0,
  PRIMARY KEY (level, permission)
);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  public INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE playlist_songs (
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL
);
