-- 036 — song_masters.lyrics column (full LRC / plain text).
--
-- Wave 3 media enhancement: getLyrics / getLyricsBySongId reads this column
-- first and only falls back to an external fetch (NetEase) when empty.
-- writeTags / batchWriteTags also accept a `lyrics` field and persist it here.
--
-- File-level tag write-back (ID3v2 USLT / FLAC VORBIS_COMMENT LYRICS) is left
-- as a TODO for 042 — the D1 column is the authoritative source until then.
--
-- Number 0014 was skipped on purpose (matches the 0012 gap policy).

ALTER TABLE song_masters ADD COLUMN lyrics TEXT;
