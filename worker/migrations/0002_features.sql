-- ============================================================================
-- 0002: Feature flags (docs/DESIGN.md §3.3)
-- ============================================================================
CREATE TABLE IF NOT EXISTS features (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO features (key, value, description) VALUES
  ('allow_being_proxied',     0, '允许本服务器被其他 EdgeSonic 作为上游二次代理'),
  ('enable_subsonic_upstream', 1, '本服务器是否启用 Subsonic 类型存储源（出站代理）'),
  ('guest_browse',            0, '允许 guest 级别浏览音乐库'),
  ('open_registration',       0, '开放用户自助注册');
