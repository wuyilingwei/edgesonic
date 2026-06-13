-- 042 — tidyFolder permission seed.
--
-- The `tidyFolder` endpoint (POST /rest/tidyFolder) moves files into a
-- template-driven layout on R2 / WebDAV. It is gated by a new permission
-- `manage_files`, defaulted to enabled for level 2+ (admin / super admin).
-- Lower levels keep it disabled.
--
-- Run order: this migration follows 0011_scrape_jobs.sql. Number 0012 was
-- skipped (041 evaluated and chose not to ship one).

INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'manage_files', 1, 0),
  (2, 'manage_files', 1, 0),
  (1, 'manage_files', 0, 0),
  (0, 'manage_files', 0, 0);
