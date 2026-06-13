-- 035 — OpenSubsonic protocol declaration
-- Add avatar R2 key column to users for getAvatar endpoint.
-- The key follows convention `avatars/{username}.{ext}` (ext determined at upload).
ALTER TABLE users ADD COLUMN avatar_r2_key TEXT;
