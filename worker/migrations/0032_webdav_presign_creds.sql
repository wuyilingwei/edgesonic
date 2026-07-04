-- 097: WebDAV read-only presign credentials
ALTER TABLE storage_sources ADD COLUMN presign_username TEXT;
ALTER TABLE storage_sources ADD COLUMN presign_password TEXT;
