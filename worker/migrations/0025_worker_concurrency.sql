-- 088 — Concurrent Web Worker count for the browser work pool.
--
-- Adds one feature_strings row: worker_max_concurrent (1..8, default 3). The
-- browser store (web/src/stores/workerPool.ts) reads this on start and uses
-- it for BOTH the /work/poll `limit=` parameter and the local Promise.all
-- fan-out. Pre-088 the limit was hardcoded to 5 and the drain was serial; this
-- knob unifies the two so admins tune one number to scale throughput per
-- participating browser.
--
-- INSERT OR IGNORE keeps the migration idempotent against re-runs and against
-- deployments that already have the row from a manual write.

INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('worker_max_concurrent', '3', 'Concurrent Web Workers per browser (1-8)', unixepoch());
