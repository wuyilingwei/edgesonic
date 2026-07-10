-- 117 — Rosmontis: "重置全部远程任务为未扫描" (reset scan status on every song
-- instance so the whole library gets re-picked-up by scan/BROWSER READ,
-- benefiting from the 116 lyrics fallback fix and anything else fixed since).
-- Scope confirmed: ALL song_instances regardless of storage source type.
-- Pairs with the existing (untracked) redispatch_metadata.sql, which
-- (re)dispatches work_queue metadata tasks for every tag_scanned=0 row —
-- run that AFTER this one so the reset rows actually get requeued.
UPDATE song_instances
SET tag_scanned = 0,
    updated_at = unixepoch()
WHERE tag_scanned != 0;
