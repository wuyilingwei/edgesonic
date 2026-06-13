-- 068 — Encrypt storage_sources.password with AES-256-GCM via env.STORAGE_KEY.
--
-- We add a NEW column rather than rewriting the existing one because:
--   1. Live deployments must keep working while STORAGE_KEY is unset (the secret
--      gets pushed AFTER this migration lands).
--   2. The adapter path (worker/src/adapters/index.ts:getDecryptedPassword)
--      uses (password_encrypted ?? password) so old rows that haven't been
--      migrated by /storage/sources/migratePasswords still authenticate.
--
-- After all sources have run through migratePasswords (and the operator has
-- verified `password=''` across the table), a follow-up task can drop the
-- legacy column. Out of scope for v1.

ALTER TABLE storage_sources ADD COLUMN password_encrypted TEXT;

-- Cheap admin lookup: "which sources still need migration?" — the partial
-- index makes the WHERE clause in migratePasswords a no-op scan when every
-- row has been encrypted (single seek into the not-null branch).
CREATE INDEX IF NOT EXISTS idx_sources_enc ON storage_sources (id)
  WHERE password_encrypted IS NOT NULL;
