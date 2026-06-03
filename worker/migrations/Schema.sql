-- ============================================================================
-- EdgeSonic Unified Schema v3
-- ============================================================================
-- Architecture:
--   Auth:     master_password (web login) → sessions (web+Subsonic dual-use)
--             subsonic_credentials (per-user, max 64, for native clients)
--   Storage:  R2 folder-nested structure with multi-bitrate versions
--             song_instances tracks source origin + transcoded/cached variants
--   Sources:  R2 (primary), WebDAV (external), Subsonic (proxied), URL (direct)
--             R2 acts as transcode cache for WebDAV/Subsonic sources
-- ============================================================================

-- ============================================================================
-- R2 Storage Convention
-- ============================================================================
-- Primary (owned files):
--   {source_id}/artists/{artist_id}/images/profile.jpg
--   {source_id}/artists/{artist_id}/albums/{album_id}/cover.jpg
--   {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/original.{suffix}
--   {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/transcode_{profile}.{suffix}
--
-- WebDAV transcode cache:
--   _cache/webdav/{source_hash}/{remote_path_sanitized}/original.{suffix}
--   _cache/webdav/{source_hash}/{remote_path_sanitized}/transcode_{profile}.{suffix}
--
-- Subsonic proxied cache:
--   _cache/subsonic/{source_hash}/{remote_id}/original.{suffix}
--   _cache/subsonic/{source_hash}/{remote_id}/transcode_{profile}.{suffix}
--
-- Uploads (user-uploaded, pending metadata):
--   _uploads/{username}/{timestamp}_{filename}
-- ============================================================================

-- ============================================================================
-- 1. Storage Sources
-- ============================================================================
CREATE TABLE storage_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webdav', 'subsonic', 'r2', 'url')),
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  last_sync INTEGER,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- 2. Users (master_password for web login)
-- ============================================================================
CREATE TABLE users (
  username TEXT PRIMARY KEY,
  master_password TEXT NOT NULL,          -- SHA-256 hashed, for web login only
  level INTEGER DEFAULT 1 CHECK (level BETWEEN 0 AND 3),
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- 3. Sessions (web login → temporary session, dual-use as Subsonic password)
-- ============================================================================
-- Created after master_password verification. Session token can also
-- authenticate Subsonic API calls (for in-browser web player streaming).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,             -- session token (also valid as Subsonic "password")
  user_agent TEXT,                        -- browser/client info
  ip_address TEXT,                        -- client IP at creation
  expires_at INTEGER NOT NULL,            -- unix timestamp
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_username ON sessions(username);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ============================================================================
-- 4. Subsonic Credentials (per-user client passwords, max 64)
-- ============================================================================
-- Non-guest users create subsonic passwords for native Subsonic clients.
-- Stored as plaintext (required by Subsonic MD5 token auth protocol).
-- Each user limited to 64 credentials (enforced at application layer).
CREATE TABLE subsonic_credentials (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL,                 -- plaintext (Subsonic protocol requirement)
  label TEXT DEFAULT '',                  -- user label e.g. "My Phone", "Desktop"
  last_used INTEGER,                      -- unix timestamp of last auth
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX idx_subsonic_cred_user ON subsonic_credentials(username);

-- ============================================================================
-- 5. User Permissions (granular per-level control)
-- ============================================================================
CREATE TABLE user_permissions (
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  permission TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  max_rph INTEGER DEFAULT 0,              -- max requests per hour (0 = unlimited)
  PRIMARY KEY (level, permission)
);

-- Level 3 (Super Admin): ALL permissions
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'stream',              1, 0),
  (3, 'download',            1, 0),
  (3, 'upload',              1, 0),
  (3, 'edit_tags',           1, 0),
  (3, 'manage_sources',      1, 0),
  (3, 'manage_users',        1, 0),
  (3, 'manage_permissions',  1, 0),
  (3, 'manage_credentials',  1, 0),
  (3, 'browse',              1, 0),
  (3, 'search',              1, 0);

-- Level 2 (Admin): edit tags, upload, download, stream, manage sources & users
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (2, 'stream',              1, 0),
  (2, 'download',            1, 0),
  (2, 'upload',              1, 0),
  (2, 'edit_tags',           1, 0),
  (2, 'manage_sources',      1, 0),
  (2, 'manage_users',        1, 0),
  (2, 'manage_permissions',  0, 0),
  (2, 'manage_credentials',  1, 0),
  (2, 'browse',              1, 0),
  (2, 'search',              1, 0);

-- Level 1 (User): stream, download, browse, search, manage own credentials
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (1, 'stream',              1, 0),
  (1, 'download',            1, 100),
  (1, 'upload',              0, 0),
  (1, 'edit_tags',           0, 0),
  (1, 'manage_sources',      0, 0),
  (1, 'manage_users',        0, 0),
  (1, 'manage_permissions',  0, 0),
  (1, 'manage_credentials',  1, 0),
  (1, 'browse',              1, 0),
  (1, 'search',              1, 0);

-- Level 0 (Guest): all disabled by default
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (0, 'stream',              0, 0),
  (0, 'download',            0, 0),
  (0, 'upload',              0, 0),
  (0, 'edit_tags',           0, 0),
  (0, 'manage_sources',      0, 0),
  (0, 'manage_users',        0, 0),
  (0, 'manage_permissions',  0, 0),
  (0, 'manage_credentials',  0, 0),
  (0, 'browse',              0, 0),
  (0, 'search',              0, 0);

-- ============================================================================
-- 6. Guest Tokens (temporary browser access)
-- ============================================================================
CREATE TABLE guest_tokens (
  token TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (created_by) REFERENCES users(username)
);
CREATE INDEX idx_guest_tokens_expires ON guest_tokens(expires_at);

-- ============================================================================
-- 7. Artists
-- ============================================================================
CREATE TABLE artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  image_r2_key TEXT,                      -- R2 key to artist image
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_artists_name ON artists(name);

-- ============================================================================
-- 8. Albums
-- ============================================================================
CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  genre TEXT,
  cover_r2_key TEXT,                      -- R2 key to cover art
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,             -- total duration in seconds
  size INTEGER DEFAULT 0,                 -- total size of all instances in bytes
  compilation INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_albums_name ON albums(name);

-- ============================================================================
-- 9. Song Masters (logical songs — one per unique track)
-- ============================================================================
CREATE TABLE song_masters (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  album_artist_id TEXT,
  title TEXT NOT NULL,
  sort_title TEXT,
  track INTEGER,
  disc INTEGER,
  duration INTEGER,                       -- canonical duration (from best source)
  genre TEXT,
  compilation INTEGER DEFAULT 0,
  participants TEXT,                      -- JSON: [{role:"composer",name:"..."}]
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (album_id) REFERENCES albums(id),
  FOREIGN KEY (artist_id) REFERENCES artists(id),
  FOREIGN KEY (album_artist_id) REFERENCES artists(id)
);
CREATE INDEX idx_songmasters_album ON song_masters(album_id);
CREATE INDEX idx_songmasters_artist ON song_masters(artist_id);
CREATE INDEX idx_songmasters_title ON song_masters(title);

-- ============================================================================
-- 10. Song Instances (physical files — one per format/source/bitrate)
-- ============================================================================
-- Each song_master can have multiple instances from different sources.
-- R2 folder: {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/
--   ├── original.flac          (instance_type='original')
--   ├── transcode_320.mp3      (instance_type='transcoded')
--   └── transcode_128.opus     (instance_type='transcoded')
-- Deduplication: source_dedup_key groups identical audio across sources.
CREATE TABLE song_instances (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  source_id TEXT NOT NULL,                -- FK to storage_sources, or 'r2-local'
  source_type TEXT DEFAULT 'original'
    CHECK (source_type IN ('original', 'transcoded', 'cached', 'external')),
  source_dedup_key TEXT,                  -- content hash for cross-source dedup
  parent_instance_id TEXT,                -- FK to self: original instance for transcoded
  storage_uri TEXT NOT NULL,              -- r2://key or webdav://source_id/path etc.
  transcode_profile TEXT,                 -- e.g. 'mp3_320', 'opus_128' (null if original)
  suffix TEXT NOT NULL,
  content_type TEXT,
  bit_rate INTEGER,                       -- kbps
  sample_rate INTEGER,                    -- Hz
  bit_depth INTEGER,                      -- bits per sample
  channels INTEGER,                       -- 1=mono, 2=stereo
  duration INTEGER,                       -- seconds
  size INTEGER,                           -- bytes
  missing INTEGER DEFAULT 0,              -- 1 if file not found at source
  expires_at INTEGER,                     -- for cached transcodes (TTL)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (master_id) REFERENCES song_masters(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_instance_id) REFERENCES song_instances(id) ON DELETE SET NULL
);
CREATE INDEX idx_instances_master ON song_instances(master_id);
CREATE INDEX idx_instances_source ON song_instances(source_id);
CREATE INDEX idx_instances_dedup ON song_instances(source_dedup_key);
CREATE INDEX idx_instances_parent ON song_instances(parent_instance_id);
CREATE INDEX idx_instances_expires ON song_instances(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================================
-- 11. Annotations (user-specific: play counts, ratings, stars)
-- ============================================================================
CREATE TABLE annotations (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
  play_count INTEGER DEFAULT 0,
  play_date INTEGER,                      -- last played timestamp
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  starred INTEGER DEFAULT 0,
  starred_at INTEGER,
  PRIMARY KEY (user_id, item_id, item_type)
);
CREATE INDEX idx_annotations_user ON annotations(user_id);

-- ============================================================================
-- 12. Playlists
-- ============================================================================
CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  public INTEGER DEFAULT 0,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  cover_r2_key TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX idx_playlists_owner ON playlists(owner);

CREATE TABLE playlist_songs (
  playlist_id TEXT NOT NULL,
  song_master_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (playlist_id, position),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
);

-- ============================================================================
-- 13. Transcode Queue (async transcode jobs)
-- ============================================================================
CREATE TABLE transcode_jobs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,              -- source instance to transcode
  profile TEXT NOT NULL,                  -- target transcode profile
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  output_instance_id TEXT,                -- resulting instance after completion
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER,
  FOREIGN KEY (instance_id) REFERENCES song_instances(id),
  FOREIGN KEY (output_instance_id) REFERENCES song_instances(id)
);
CREATE INDEX idx_transcode_jobs_status ON transcode_jobs(status);

-- ============================================================================
-- Auth Flow Summary
-- ============================================================================
-- Web Login:
--   1. POST /rest/loginWeb { username, master_password }
--   2. Server: SHA-256(input) == users.master_password?
--   3. Create session → store in sessions table + KV cache
--   4. Return { session_token, username, level }
--
-- Subsonic API Auth (all clients):
--   1. Client sends u, t, s where t = md5(credential + s)
--   2. Server looks up credential matching username:
--      a. Check subsonic_credentials.password (native client passwords)
--      b. Check sessions.token (web session tokens)
--      c. Legacy: check users.master_password (backward compat)
--   3. Compute expected = md5(found_credential + s)
--   4. Compare expected == t
--
-- Session as Subsonic Password:
--   Web player uses session_token as the Subsonic "password":
--   t = md5(session_token + s)
--   → Server finds session by token → verifies → streams audio in browser
-- ============================================================================

-- ============================================================
-- Playlists
-- ============================================================
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
