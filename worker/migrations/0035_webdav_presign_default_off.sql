-- 108 — WebDAV userinfo presign redirects (302 → https://user:pass@host/...)
-- are rejected by browsers, ExoPlayer, AVFoundation and most Subsonic
-- clients, and leak the WebDAV credentials to any client allowed to stream.
-- Flip the feature to OFF; the in-Worker proxy stream is the interoperable
-- default. Admins with a controlled client set can re-enable via Settings.
UPDATE feature_strings
   SET value = '0', updated_at = unixepoch()
 WHERE key = 'enable_webdav_presign' AND value = '1';
