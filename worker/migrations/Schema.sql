-- ============================================================================
-- EdgeSonic Unified Schema v3 (consolidated — single source of truth)
-- ============================================================================
-- Architecture:
--   Auth:   master_password (web login) → sessions (web+Subsonic dual-use)
--           subsonic_credentials (per-user, max 64, for native clients)
--  Storage: R2 folder-nested structure with multi-bitrate versions
--           song_instances tracks source origin + transcoded/cached variants
--  Sources: R2 (primary), WebDAV (external), Subsonic (proxied), URL (direct)
--           R2 acts as transcode cache for WebDAV/Subsonic sources
--
-- This file is the complete, idempotent schema and the single source of
-- truth. All CREATE statements use IF NOT EXISTS and all seeds use
-- INSERT OR IGNORE / INSERT OR REPLACE so re-running on an existing DB is
-- safe. The individual migration files (0001_initial.sql …
-- 0039_clone_id_map.sql) have been removed; their content is folded into
-- this file. Fresh deployments execute this file once; no incremental
-- patches are shipped.
-- ============================================================================

-- ============================================================================
-- R2 Storage Convention
-- ============================================================================
-- Primary (owned files):
--  {source_id}/artists/{artist_id}/images/profile.jpg
--  {source_id}/artists/{artist_id}/albums/{album_id}/cover.jpg
--  {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/original.{suffix}
--  {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/transcode_{profile}.{suffix}
--
-- WebDAV transcode cache:
--  _cache/webdav/{source_hash}/{remote_path_sanitized}/original.{suffix}
--  _cache/webdav/{source_hash}/{remote_path_sanitized}/transcode_{profile}.{suffix}
--
-- Subsonic proxied cache:
--  _cache/subsonic/{source_hash}/{remote_id}/original.{suffix}
--  _cache/subsonic/{source_hash}/{remote_id}/transcode_{profile}.{suffix}
--
-- Uploads (user-uploaded, pending metadata):
--  _uploads/{username}/{timestamp}_{filename}
-- ============================================================================

-- ============================================================================
-- 1. Storage Sources
-- ============================================================================
CREATE TABLE IF NOT EXISTS storage_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webdav', 'subsonic', 'r2', 'url', 's3')),
  name TEXT NOT NULL DEFAULT '',                     -- 005: human-readable label
  base_url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  password_encrypted TEXT,                           -- 023: AES-256-GCM blob (`v1:<base64url>`) — unused after crypto removal, column kept for compat
  presign_username TEXT,                             -- 097: optional read-only WebDAV account for presign URL (falls back to username if null)
  presign_password TEXT,                             -- 097: paired with presign_username
  root_path TEXT NOT NULL DEFAULT '',                -- 003: path inside the remote; effective URL = base_url + root_path
  region TEXT NOT NULL DEFAULT 'us-east-1',          -- 096: SigV4 region (MinIO: any value; R2: 'auto'; AWS: real region)
  last_sync INTEGER,
  enabled INTEGER DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'library',              -- 026: 'library' | 'sync_only'
  cache_tier TEXT NOT NULL DEFAULT 'off'             -- R2 hot-cache tier for this source's remote files
    CHECK (cache_tier IN ('off', 'standard', 'extended')),
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sources_enc ON storage_sources (id) WHERE password_encrypted IS NOT NULL;

-- ============================================================================
-- 2. Users (master_password for web login)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  master_password TEXT NOT NULL,                     -- SHA-256 hashed, for web login only
  level INTEGER DEFAULT 1 CHECK (level BETWEEN 0 AND 3),
  enabled INTEGER DEFAULT 1,
  avatar_r2_key TEXT,                                -- 014/035: R2 key for getAvatar (NULL → no avatar)
  nickname TEXT,                                      -- EdgeSonic display name (NULL → fall back to username)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- ============================================================================
-- 3. Sessions (web login → temporary session, dual-use as Subsonic password)
-- ============================================================================
-- Created after master_password verification. Session token can also
-- authenticate Subsonic API calls (for in-browser web player streaming).
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,                         -- session token (also valid as Subsonic "password")
  user_agent TEXT,                                   -- browser/client info
  ip_address TEXT,                                   -- client IP at creation
  expires_at INTEGER NOT NULL,                       -- unix timestamp
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================================
-- 4. Subsonic Credentials (per-user client passwords, max 64)
-- ============================================================================
-- Non-guest users create subsonic passwords for native Subsonic clients.
-- Stored as plaintext (required by Subsonic MD5 token auth protocol).
-- Each user limited to 64 credentials (enforced at application layer).
CREATE TABLE IF NOT EXISTS subsonic_credentials (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL,                            -- plaintext (Subsonic protocol requirement)
  label TEXT DEFAULT '',                             -- user label e.g. "My Phone", "Desktop"
  stream_proxy_strategy TEXT NOT NULL DEFAULT 'always', -- 092: 'always'|'never'|'r2_only'|'webdav_only'
  last_used INTEGER,                                 -- unix timestamp of last auth
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subsonic_cred_user ON subsonic_credentials(username);

-- ============================================================================
-- 5. User Permissions (granular per-level control)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_permissions (
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  permission TEXT NOT NULL,
  enabled INTEGER DEFAULT 0,
  max_rph INTEGER DEFAULT 0,                         -- max requests per hour (0 = unlimited)
  PRIMARY KEY (level, permission)
);

-- ============================================================================
-- Default permission matrix
-- ----------------------------------------------------------------------------
-- Level 3 (Super Admin): always holds every permission server-side regardless
--   of the rows below (see utils/permissions.ts hasPermission / getEffective
--   Permissions — level 3 short-circuits to true). The rows for level 3 here
--   are kept only for /permissions/list display parity and as a recovery
--   fallback in case the short-circuit is ever removed.
-- Level 2 (Admin): edit-class + baseline read/write. Cannot manage
--   permissions, system settings, Cloudflare integration, or maintenance
--   tooling — those stay super-admin-only.
-- Level 1 (User): playback + download + browse + self annotations + own
--   playlists + sharing + work-pool participation. No edit_tags, no
--   manage_files, no delete, no upload, no user/source management.
-- Level 0 (Guest): web-only playback. stream + browse + search only; no
--   download, no annotations, no playlists, no shares, no credentials, no
--   self-profile edits (avatar/nickname/password blocked server-side).
-- ============================================================================
INSERT OR REPLACE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  -- Level 3 (Super Admin): all permissions (cosmetic — short-circuited at read)
  (3, 'stream',              1, 0),
  (3, 'download',            1, 0),
  (3, 'upload',              1, 0),
  (3, 'delete',              1, 0),
  (3, 'edit_tags',           1, 0),
  (3, 'edit_annotations',    1, 0),
  (3, 'manage_files',        1, 0),
  (3, 'manage_playlists',    1, 0),
  (3, 'manage_radio',        1, 0),
  (3, 'manage_podcasts',     1, 0),
  (3, 'share',               1, 0),
  (3, 'manage_sources',      1, 0),
  (3, 'manage_users',        1, 0),
  (3, 'manage_credentials',  1, 0),
  (3, 'manage_permissions',  1, 0),
  (3, 'manage_settings',     1, 0),
  (3, 'manage_cloudflare',   1, 0),
  (3, 'maintenance_cleanup', 1, 0),
  (3, 'maintenance_reclaim', 1, 0),
  (3, 'maintenance_reset',   1, 0),
  (3, 'participate_work',    1, 0),
  (3, 'dispatch_work',       1, 0),
  (3, 'view_all_users_items',1, 0),
  (3, 'browse',              1, 0),
  (3, 'search',              1, 0),

  -- Level 2 (Admin): edit-class + baseline read/write
  (2, 'stream',              1, 0),
  (2, 'download',            1, 0),
  (2, 'upload',              1, 0),
  (2, 'delete',              1, 0),
  (2, 'edit_tags',           1, 0),
  (2, 'edit_annotations',    1, 0),
  (2, 'manage_files',        1, 0),
  (2, 'manage_playlists',    1, 0),
  (2, 'manage_radio',        1, 0),
  (2, 'manage_podcasts',     1, 0),
  (2, 'share',               1, 0),
  (2, 'manage_sources',      1, 0),
  (2, 'manage_users',        1, 0),
  (2, 'manage_credentials',  1, 0),
  (2, 'manage_permissions',  0, 0),
  (2, 'manage_settings',     0, 0),
  (2, 'manage_cloudflare',   0, 0),
  (2, 'maintenance_cleanup', 0, 0),
  (2, 'maintenance_reclaim', 0, 0),
  (2, 'maintenance_reset',   0, 0),
  (2, 'participate_work',    1, 0),
  (2, 'dispatch_work',       0, 0),
  (2, 'view_all_users_items',0, 0),
  (2, 'browse',              1, 0),
  (2, 'search',              1, 0),

  -- Level 1 (User): playback + download + browse + self annotations + own
  -- playlists + sharing + work-pool participation
  (1, 'stream',              1, 0),
  (1, 'download',            1, 100),
  (1, 'upload',              0, 0),
  (1, 'delete',              0, 0),
  (1, 'edit_tags',           0, 0),
  (1, 'edit_annotations',    1, 0),
  (1, 'manage_files',        0, 0),
  (1, 'manage_playlists',    1, 0),
  (1, 'manage_radio',        0, 0),
  (1, 'manage_podcasts',     0, 0),
  (1, 'share',               1, 0),
  (1, 'manage_sources',      0, 0),
  (1, 'manage_users',        0, 0),
  (1, 'manage_credentials',  0, 0),
  (1, 'manage_permissions',  0, 0),
  (1, 'manage_settings',     0, 0),
  (1, 'manage_cloudflare',   0, 0),
  (1, 'maintenance_cleanup', 0, 0),
  (1, 'maintenance_reclaim', 0, 0),
  (1, 'maintenance_reset',  0, 0),
  (1, 'participate_work',    1, 0),
  (1, 'dispatch_work',       0, 0),
  (1, 'view_all_users_items',0, 0),
  (1, 'browse',              1, 0),
  (1, 'search',              1, 0),

  -- Level 0 (Guest): web-only playback
  (0, 'stream',              1, 0),
  (0, 'download',            0, 0),
  (0, 'upload',              0, 0),
  (0, 'delete',              0, 0),
  (0, 'edit_tags',           0, 0),
  (0, 'edit_annotations',    0, 0),
  (0, 'manage_files',        0, 0),
  (0, 'manage_playlists',    0, 0),
  (0, 'manage_radio',        0, 0),
  (0, 'manage_podcasts',     0, 0),
  (0, 'share',               0, 0),
  (0, 'manage_sources',      0, 0),
  (0, 'manage_users',        0, 0),
  (0, 'manage_credentials',  0, 0),
  (0, 'manage_permissions',  0, 0),
  (0, 'manage_settings',     0, 0),
  (0, 'manage_cloudflare',   0, 0),
  (0, 'maintenance_cleanup', 0, 0),
  (0, 'maintenance_reclaim', 0, 0),
  (0, 'maintenance_reset',  0, 0),
  (0, 'participate_work',    0, 0),
  (0, 'dispatch_work',       0, 0),
  (0, 'view_all_users_items',0, 0),
  (0, 'browse',              1, 0),
  (0, 'search',              1, 0);


-- ============================================================================
-- 6. Guest Tokens (temporary browser access)
-- ============================================================================
CREATE TABLE IF NOT EXISTS guest_tokens (
  token TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (created_by) REFERENCES users(username)
);
CREATE INDEX IF NOT EXISTS idx_guest_tokens_expires ON guest_tokens(expires_at);

-- ============================================================================
-- 7. Artists
-- ============================================================================
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  image_r2_key TEXT,                                 -- R2 key to artist image
  image_url TEXT,                                    -- external image URL (e.g. last.fm / scrape fallback)
  biography TEXT,                                    -- artist biography (last.fm content, or CN scrape fallback)
  biography_source TEXT,                             -- which source filled biography: 'lastfm' | 'netease' | 'qmusic'
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);

-- ============================================================================
-- 8. Albums
-- ============================================================================
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  genre TEXT,
  cover_r2_key TEXT,                                 -- R2 key to cover art
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,                        -- total duration in seconds
  size INTEGER DEFAULT 0,                            -- total size of all instances in bytes
  compilation INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_albums_name ON albums(name);

-- ============================================================================
-- 9. Song Masters (logical songs — one per unique track)
-- ============================================================================
CREATE TABLE IF NOT EXISTS song_masters (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  album_artist_id TEXT,
  title TEXT NOT NULL,
  sort_title TEXT,
  track INTEGER,
  disc INTEGER,
  duration INTEGER,                                  -- canonical duration (from best source)
  genre TEXT,
  compilation INTEGER DEFAULT 0,
  participants TEXT,                                 -- JSON: [{role:"composer",name:"..."}]
  lyrics TEXT,                                       -- 015/036: full LRC / plain text; getLyrics reads here first
  lyrics_rich TEXT,                                  -- 0259: JSON-serialized RichLyrics (cueLine/cue/agents) for songLyrics v2; NULL when only line-level LRC is available
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (album_id) REFERENCES albums(id),
  FOREIGN KEY (artist_id) REFERENCES artists(id),
  FOREIGN KEY (album_artist_id) REFERENCES artists(id)
);
CREATE INDEX IF NOT EXISTS idx_songmasters_album ON song_masters(album_id);
CREATE INDEX IF NOT EXISTS idx_songmasters_artist ON song_masters(artist_id);
CREATE INDEX IF NOT EXISTS idx_songmasters_title ON song_masters(title);

CREATE TABLE IF NOT EXISTS song_artists (
  song_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (song_id, artist_id),
  FOREIGN KEY (song_id) REFERENCES song_masters(id) ON DELETE CASCADE,
  FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_songartists_artist ON song_artists(artist_id);

-- ============================================================================
-- 10. Song Instances (physical files — one per format/source/bitrate)
-- ============================================================================
-- Each song_master can have multiple instances from different sources.
-- R2 folder: {source_id}/artists/{artist_id}/albums/{album_id}/songs/{master_id}/
--   ├── original.flac        (instance_type='original')
--   ├── transcode_320.mp3    (instance_type='transcoded')
--   └── transcode_128.opus   (instance_type='transcoded')
-- Deduplication: source_dedup_key groups identical audio across sources.
CREATE TABLE IF NOT EXISTS song_instances (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  source_id TEXT NOT NULL,                           -- FK to storage_sources, or 'r2-local'
  source_type TEXT DEFAULT 'original'
    CHECK (source_type IN ('original', 'transcoded', 'cached', 'external')),
  source_dedup_key TEXT,                             -- content hash for cross-source dedup
  parent_instance_id TEXT,                           -- FK to self: original instance for transcoded
  storage_uri TEXT NOT NULL,                         -- r2://key or webdav://source_id/path etc.
  transcode_profile TEXT,                            -- e.g. 'mp3_320', 'opus_128' (null if original)
  suffix TEXT NOT NULL,
  content_type TEXT,
  bit_rate INTEGER,                                  -- kbps
  sample_rate INTEGER,                               -- Hz
  bit_depth INTEGER,                                 -- bits per sample
  channels INTEGER,                                  -- 1=mono, 2=stereo
  duration INTEGER,                                  -- seconds
  size INTEGER,                                      -- bytes
  missing INTEGER DEFAULT 0,                         -- 1 if file not found at source
  tag_scanned INTEGER NOT NULL DEFAULT 0,            -- 004: 0=not scanned, 1=tags applied, 2=no usable tags
  source_etag TEXT,                                  -- 020: remote ETag for incremental scan skip
  source_last_modified INTEGER,                      -- 020: remote last_modified (unix seconds)
  expires_at INTEGER,                                -- hard TTL ceiling for source_type='cached' rows, set once at cache-write time, never extended
  last_accessed_at INTEGER,                          -- bumped on each cache hit; LRU key for evictForRoom (NULL sorts first = evicted before any real hit)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (master_id) REFERENCES song_masters(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_instance_id) REFERENCES song_instances(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_master ON song_instances(master_id);
CREATE INDEX IF NOT EXISTS idx_instances_source ON song_instances(source_id);
CREATE INDEX IF NOT EXISTS idx_instances_dedup ON song_instances(source_dedup_key);
CREATE INDEX IF NOT EXISTS idx_instances_parent ON song_instances(parent_instance_id);
CREATE INDEX IF NOT EXISTS idx_instances_expires ON song_instances(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_cached_lru ON song_instances(parent_instance_id, last_accessed_at) WHERE source_type = 'cached' AND missing = 0;
CREATE INDEX IF NOT EXISTS idx_si_pending_scan
  ON song_instances (source_id, tag_scanned) WHERE tag_scanned = 0;

-- ============================================================================
-- 11. Annotations (user-specific: play counts, ratings, stars)
-- ============================================================================
CREATE TABLE IF NOT EXISTS annotations (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
  play_count INTEGER DEFAULT 0,
  play_date INTEGER,                                 -- last played timestamp
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  starred INTEGER DEFAULT 0,
  starred_at INTEGER,
  PRIMARY KEY (user_id, item_id, item_type)
);
CREATE INDEX IF NOT EXISTS idx_annotations_user ON annotations(user_id);
CREATE INDEX IF NOT EXISTS idx_annotations_starred ON annotations(user_id, item_type, starred);
CREATE INDEX IF NOT EXISTS idx_annotations_rating ON annotations(user_id, item_type, rating);
CREATE INDEX IF NOT EXISTS idx_annotations_played ON annotations(user_id, item_type, play_date);

-- Clone identity map: remote Subsonic ids are not always valid local ids.
-- Persist source-scoped mappings so clone audio, playlists and stars all point
-- at the same local entities selected by /edgesonic/clone/upsertMaster.
CREATE TABLE IF NOT EXISTS clone_id_map (
  source_key TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source_key, item_type, remote_id)
);

-- ============================================================================
-- 12. Playlists
-- ============================================================================
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  public INTEGER DEFAULT 0,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  cover_r2_key TEXT,
  comment TEXT,                                      -- 007: free-form description
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner);
CREATE INDEX IF NOT EXISTS idx_playlists_owner_public ON playlists(owner, public);

CREATE TABLE IF NOT EXISTS playlist_songs (
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
CREATE TABLE IF NOT EXISTS transcode_jobs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,                         -- source instance to transcode
  profile TEXT NOT NULL,                             -- target transcode profile
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  output_instance_id TEXT,                           -- resulting instance after completion
  engine TEXT,                                       -- 010: which backend ran it (sandbox|external|browser_pool)
  profile_id TEXT,                                   -- 010: catalogue id of the target profile
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER,
  FOREIGN KEY (instance_id) REFERENCES song_instances(id),
  FOREIGN KEY (output_instance_id) REFERENCES song_instances(id)
);
CREATE INDEX IF NOT EXISTS idx_transcode_jobs_status ON transcode_jobs(status);

-- ============================================================================
-- 14. Internet Radio Stations (045)
-- ============================================================================
-- Subsonic standard station directory; clients connect to stream_url directly
-- (no proxy on EdgeSonic). CUD is admin-gated via the `manage_radio` permission.
CREATE TABLE IF NOT EXISTS internet_radio_stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  homepage_url TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (created_by) REFERENCES users(username) ON DELETE SET NULL
);

-- ============================================================================
-- 15. Podcasts (046)
-- ============================================================================
-- Subsonic Podcast API + hourly Cron RSS refresh. Channels subscribe by URL;
-- episodes come from RSS and only land in R2 when an admin opts an episode in
-- via downloadPodcastEpisode (ctx.waitUntil keeps the Worker alive).
CREATE TABLE IF NOT EXISTS podcast_channels (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  language TEXT,
  status TEXT NOT NULL DEFAULT 'new',                -- new / completed / error
  error_message TEXT,
  last_refreshed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS podcast_episodes (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT,
  description TEXT,
  audio_url TEXT,
  published_at INTEGER,
  duration INTEGER,
  size INTEGER,
  bit_rate INTEGER,
  status TEXT NOT NULL DEFAULT 'new',                 -- new / downloading / completed / error
  downloaded_r2_key TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (channel_id, guid),
  FOREIGN KEY (channel_id) REFERENCES podcast_channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel_pub
  ON podcast_episodes (channel_id, published_at DESC);

-- ============================================================================
-- 16. Shares (044) — public share links targeting one or more song masters
-- ============================================================================
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT,
  expires_at INTEGER,                               -- unix seconds; NULL = never expires
  view_count INTEGER NOT NULL DEFAULT 0,
  last_visited_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);

CREATE TABLE IF NOT EXISTS share_entries (
  share_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  song_master_id TEXT NOT NULL,
  PRIMARY KEY (share_id, position),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_entries_song ON share_entries(song_master_id);

-- ============================================================================
-- 17. Bookmarks + Play Queues (037)
-- ============================================================================
-- Per-user bookmarks (resume point per song) and a single saved play queue
-- per user (Subsonic getBookmarks / createBookmark / deleteBookmark /
-- getPlayQueue / savePlayQueue). Last-write-wins; no multi-device merge.
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  song_master_id TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, song_master_id),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id);

CREATE TABLE IF NOT EXISTS play_queues (
  user_id TEXT PRIMARY KEY,
  song_ids TEXT NOT NULL,                            -- JSON array of song_master_ids (preserves order)
  current_id TEXT,                                   -- song_master_id of currently playing entry
  position_ms INTEGER NOT NULL DEFAULT 0,
  changed_by TEXT,                                   -- Subsonic client name / device
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
);

-- ============================================================================
-- 18. Scan Jobs (0009) — persisted background scan tracking
-- ============================================================================
-- Each invocation of /rest/startScan inserts one row per source; the scan
-- itself runs in ctx.waitUntil and updates scanned_items as it progresses.
-- getScanStatus aggregates the most recent jobs across all sources.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  FOREIGN KEY (source_id) REFERENCES storage_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_source_started ON scan_jobs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status);

-- ============================================================================
-- 19. Scrape Jobs (040) — metadata scrape audit table
-- ============================================================================
-- write-only audit log: one row per /rest/scrapeMetadata proxy call
-- (status='fetched'), /rest/submitScrapeResult write (status='applied'),
-- or either above when it errors (status='failed', error_message set).
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  song_master_id TEXT,
  source TEXT NOT NULL,                              -- 'netease' / 'qmusic' / 'kugou' ...
  query TEXT,
  remote_song_id TEXT,
  result_json TEXT,                                  -- ScrapeResult JSON (subset of upstream payload)
  status TEXT NOT NULL,                              -- 'fetched' / 'applied' / 'failed'
  mode TEXT,                                         -- 'tags' / 'cover' / 'both' (applied rows only)
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE,
  FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_user_created ON scrape_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_master ON scrape_jobs (song_master_id);

-- ============================================================================
-- 20. Work Queue (052) — browser worker pool task queue
-- ============================================================================
-- Logged-in users (level ≥ 2) can opt in to becoming a worker node: their
-- browser polls /edgesonic/work/poll every ~5 minutes and runs queued tasks
-- (metadata parse, third-party scrape) inside a Web Worker, then POSTs the
-- result back via /edgesonic/work/submit. The Worker only schedules
-- non-realtime jobs here (user-facing /stream still runs inline).
CREATE TABLE IF NOT EXISTS work_queue (
  id              TEXT PRIMARY KEY,
  task_type       TEXT NOT NULL,                     -- 'metadata' | 'scrape' (transcode removed in 089)
  payload         TEXT NOT NULL,                     -- JSON blob (task-shaped)
  required_caps   TEXT,                              -- JSON array of capability strings; NULL = any
  priority        INTEGER NOT NULL DEFAULT 5,        -- 1..10, lower runs first
  status          TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'completed', 'failed', 'canceled')),
  claimed_by      TEXT,                              -- username of the browser node
  claimed_at      INTEGER,
  heartbeat_at    INTEGER,
  result_json     TEXT,                              -- successful payload (JSON)
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at      INTEGER,
  FOREIGN KEY (claimed_by) REFERENCES users(username) ON DELETE SET NULL
);

-- Pickup query: oldest queued row first, priority-respecting.
CREATE INDEX IF NOT EXISTS idx_work_pickup
  ON work_queue (priority, created_at) WHERE status = 'queued';

-- Heartbeat sweep: scheduled handler scans claimed rows whose heartbeat aged
-- past worker_claim_ttl_seconds.
CREATE INDEX IF NOT EXISTS idx_work_claimed
  ON work_queue (claimed_by, heartbeat_at) WHERE status = 'claimed';

-- ============================================================================
-- ============================================================================
-- Integer-typed feature flags. String/JSON-valued flags live in feature_strings
-- (section 22 below).
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO features (key, value, description) VALUES
  ('allow_being_proxied',     1, '允许本服务器被其他 EdgeSonic 作为上游二次代理'),
  ('enable_subsonic_upstream', 1, '本服务器是否启用 Subsonic 类型存储源（出站代理）'),
  ('guest_browse',            0, '允许 guest 级别浏览音乐库'),
  ('open_registration',       0, '开放用户自助注册');

-- 0011: scrape_enabled master switch
INSERT OR IGNORE INTO features (key, value, description, updated_at) VALUES
  ('scrape_enabled', 1, '元数据刮削总开关', unixepoch());
-- Back-fill the Chinese description on databases seeded with the old English
-- text (guarded so a user-edited description is never overwritten).
UPDATE features SET description = '元数据刮削总开关'
  WHERE key = 'scrape_enabled' AND description = 'Master switch for metadata scraping';

-- ============================================================================
-- ============================================================================
-- String/JSON-valued feature flags. Used by 049 transcode engine, 051 scan,
-- 052 work pool, 065 COOP/COEP, 088 concurrency, 091/092 presign.
CREATE TABLE IF NOT EXISTS feature_strings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at  INTEGER DEFAULT (unixepoch())
);

-- 0010: 049 transcode engine defaults
INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('transcode_engine',           'disabled', '转码引擎 (sandbox|external|disabled)'),
  ('transcode_mode',             'on_demand', '转码触发模式 (on_demand|pre_bake|both)'),
  ('default_transcode_profiles', '[]',        '默认预生成档位 JSON 数组（profile id 列表）'),
  ('external_transcoder_url',    '',          '外部转码器 URL（仅在 engine=external 时生效）');

-- 0011: scrape source priority
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('scrape_enabled_sources', '["netease","qmusic","kugou"]', 'Enabled scrape sources in priority order (JSON array)', unixepoch());

-- 0016: lastfm api key (empty = off)
INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('lastfm_api_key', '', 'Last.fm API key for metadata proxy (empty = disabled)');

-- 0260 (was 0253): full artist bio/cover source priority list. Tried in
-- array order, first enabled hit wins last.fm is no longer hardcoded first —
-- CN sources default ahead of it since they cover CN artists far better.
-- A source not present in the array is disabled (self-healing: pre-260
-- deployments whose stored value is '["netease","qmusic"]' keep last.fm off
-- until an admin explicitly re-adds it — this seed only affects fresh installs).
INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('lastfm_fallback_sources', '["netease","qmusic","lastfm"]', 'Artist bio/cover source priority list (netease/qmusic/lastfm), tried in array order; JSON array, empty = all disabled');

-- 0253: cadence (hours) for the cron-driven batch backfill that scans artists
-- missing biography / cover and tries netease/qmusic. Default 24h; 0=disabled.
INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('artist_scrape_interval_hours', '24', 'Hours between automatic artist bio/cover backfill scans (0=disabled)');

-- 178: declarative S2S relay policy advertised via getOpenSubsonicExtensions
-- (OpenSubsonic #254). Empty → derived from allow_being_proxied (allow/deny);
-- set explicitly to allow|deny|no-cache to override.
INSERT OR IGNORE INTO feature_strings (key, value, description) VALUES
  ('server_relay_policy', '', 'S2S 中继策略 (allow|deny|no-cache；空=依 allow_being_proxied 推导)');

-- 0020: 051 incremental scan tunables
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('scan_interval_hours', '6', 'WebDAV auto-scan interval in hours; 0 = disabled', unixepoch()),
  ('scan_etag_check',     '1', '0|1 — use ETag/lastModified/size triple to skip unchanged files', unixepoch()),
  ('scan_rescan_strategy','auto', 'auto|worker|browser — who re-reads tags on change', unixepoch()),
  ('scan_browser_auto',   '1', '0|1 — Files.vue auto-drains pending metadata queue', unixepoch());

-- 0021: 052 work pool tunables
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('worker_pool_enabled',          '1',   'Whether the browser work pool is active (0|1)', unixepoch()),
  ('worker_poll_interval_seconds', '300', 'Client poll interval in seconds (default 5 min)', unixepoch()),
  ('worker_batch_size',            '5',   'Max tasks returned per /work/poll call',          unixepoch()),
  ('worker_claim_ttl_seconds',     '60',  'Heartbeat timeout before stale claim is re-queued', unixepoch());

-- 0022: 065 cross-origin isolation (default ON)
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('enable_cross_origin_isolation',
   '1',
   'COOP/COEP response headers — required for SharedArrayBuffer + ffmpeg.wasm multi-thread. 0|1.',
   unixepoch());

-- 0025: 088 concurrent workers (1..8, default 3)
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('worker_max_concurrent', '3', 'Concurrent Web Workers per browser (1-8)', unixepoch());

-- 0028: 091 R2 presign (default OFF — needs R2 S3 secrets; see SECRETS.md §3)
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('enable_r2_presign', '0', 'R2 presigned URL direct stream (0=off, 1=on; needs R2 S3 secrets)', unixepoch());

-- 0030: 092 WebDAV presign — 0035/108: default OFF. The userinfo redirect
-- (user:pass@host) is rejected by browsers/ExoPlayer/AVFoundation and leaks
-- WebDAV credentials to streaming clients; in-Worker proxy is the default.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('enable_webdav_presign', '0', 'WebDAV presigned URL direct stream (0=off, 1=on; leaks creds to clients — see 108)', unixepoch());

-- 0033: 101 R2 cost estimation — free-tier allocation setting
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('r2_free_allocation_gb', '10',
   'GB of R2 free tier (10 GB total) allocated to EdgeSonic for monthly cost estimation',
   unixepoch());

-- replaces the old single global enable_webdav_hotcache boolean with a
-- per-source cache_tier (storage_sources.cache_tier). These two rows hold the
-- tunable budget/per-file-cap/TTL for the 'standard' and 'extended' presets;
-- 'off' needs no config. JSON: {"budgetMb":N,"maxFileMb":N,"ttlDays":N}.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('cache_tier_standard', '{"budgetMb":2048,"maxFileMb":300,"ttlDays":30}',
   'Standard cache tier: total budget / per-file cap / TTL for sources set to cache_tier=standard',
   unixepoch()),
  ('cache_tier_extended', '{"budgetMb":10240,"maxFileMb":1024,"ttlDays":5}',
   'Extended cache tier: larger budget and per-file cap but a short TTL, for sources set to cache_tier=extended',
   unixepoch());

-- 0036: 110 periodic browser-pool metadata re-check (unsupported formats +
-- lyrics/disc backfill). Default 24h; 0 disables.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('metadata_recheck_interval_hours', '24',
   'Hours between automatic browser-pool metadata re-checks for unsupported-format or lyrics/disc-incomplete songs (0=disabled)',
   unixepoch());

-- 0038: 113 periodic batch LRC sidecar backfill for the pre-existing library.
-- Default 24h; 0 disables.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('lrc_backfill_interval_hours', '24',
   'Hours between automatic batch scans for sibling .lrc sidecar files on songs still missing lyrics (0=disabled)',
   unixepoch());

-- 199: Security — allow level 1+ users to generate their own API credentials
-- Default ON (1). When enabled, users can create/manage Subsonic credentials
-- for third-party clients. When disabled (0), only admins (level 2+) can
-- manage credentials.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('allow_user_credentials', '1',
   'Allow level 1+ users to generate their own API credentials (0=disabled, 1=enabled)',
   unixepoch());

-- ============================================================================
-- ============================================================================
-- Stored as plain TEXT for now; admin-gated endpoints read/write only.
CREATE TABLE IF NOT EXISTS external_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER DEFAULT (unixepoch())
);

-- A single empty placeholder so admin UI can GET it without 404.
INSERT OR IGNORE INTO external_secrets (key, value) VALUES
  ('external_transcoder_key', '');

-- ============================================================================
-- 24. KV→D1 migration (090, migration 0027)
-- ============================================================================
-- api_keys — API key authentication (formerly KV `apikey:{key}`)
CREATE TABLE IF NOT EXISTS api_keys (
  api_key TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- rate_limits — Per-user per-permission RPH counter (formerly KV `rph:user:perm`)
CREATE TABLE IF NOT EXISTS rate_limits (
  username TEXT NOT NULL,
  permission TEXT NOT NULL,
  window_start INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, permission)
);

-- kv_store — Generic KV (currently: cron:last_scan_ts)
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- now_playing — Active stream registry (formerly KV `now_playing:{username}`, 300s TTL)
CREATE TABLE IF NOT EXISTS now_playing (
  username TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- lastfm_cache — Last.fm 24h response cache (formerly KV `lastfm:{method}:{params}`)
CREATE TABLE IF NOT EXISTS lastfm_cache (
  cache_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lastfm_cache_expires ON lastfm_cache(expires_at);

-- ============================================================================
-- 25. User Settings (0037)
-- ============================================================================
-- Per-user settings (e.g. a personal Last.fm API key that takes precedence
-- over the system-level feature_strings.lastfm_api_key fallback). General
-- key/value store for future per-user configuration.
CREATE TABLE IF NOT EXISTS user_settings (
  username  TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, key)
);

-- ============================================================================
-- Auth Flow Summary
-- ============================================================================
-- Web Login:
--  1. POST /rest/loginWeb { username, master_password }
--  2. Server: SHA-256(input) == users.master_password?
--  3. Create session → store in sessions table + KV cache
--  4. Return { session_token, username, level }
--
-- Subsonic API Auth (all clients):
--  1. Client sends u, t, s where t = md5(credential + s)
--  2. Server looks up credential matching username:
--    a. Check subsonic_credentials.password (native client passwords)
--    b. Check sessions.token (web session tokens)
--    c. Legacy: check users.master_password (backward compat)
--  3. Compute expected = md5(found_credential + s)
--  4. Compare expected == t
--
-- Session as Subsonic Password:
--  Web player uses session_token as the Subsonic "password":
--  t = md5(session_token + s)
--  → Server finds session by token → verifies → streams audio in browser
-- ============================================================================

-- ============================================================================
-- 0253 — artist biography / image_url columns for CN scrape fallback.
-- Idempotent ALTERs; SQLite rejects ADD COLUMN if the column already exists,
-- so we guard with a PRAGMA-based check via the application's schema_patch
-- helper (see utils/schema_patch.ts). These statements are safe to re-run
-- only through that helper; direct `wrangler d1 execute --file` will fail
-- on the second run because the column already exists.
-- ============================================================================
-- ALTER TABLE artists ADD COLUMN image_url TEXT;
-- ALTER TABLE artists ADD COLUMN biography TEXT;
-- ALTER TABLE artists ADD COLUMN biography_source TEXT;
