-- 103: WebDAV play-through hot cache — copy the streamed file to R2 in the
-- background so subsequent plays use the r2:// instance (Worker binding fast
-- path + enable_r2_presign 302 direct fetch), bypassing the sub-request
-- bandwidth pool that throttles proxied WebDAV streams for browser sessions.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('enable_webdav_hotcache', '0',
   'Copy WebDAV songs to R2 on first play so later plays stream from R2 (faster). Uses R2 storage.',
   unixepoch());
