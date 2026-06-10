-- Storage sources: explicit root path inside the remote (esp. WebDAV).
-- Effective URL = base_url + root_path.
ALTER TABLE storage_sources ADD COLUMN root_path TEXT NOT NULL DEFAULT '';
