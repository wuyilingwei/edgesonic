-- ============================================================================
-- 0021: 052 — Browser worker pool (work_queue + permissions + feature strings)
-- ============================================================================
-- A logged-in user (level ≥ 2) opts in via Settings, the browser polls /
-- edgesonic/work/poll every 5 minutes and drains queued tasks (metadata
-- parsing, transcode, third-party scrape) inside a Web Worker. Results are
-- POSTed back via /edgesonic/work/submit. This migration ships:
--   1. work_queue table — atomic claim via D1 RETURNING
--   2. partial indexes for the two common queries (pickup + heartbeat sweep)
--   3. four feature_strings — runtime toggles for the whole subsystem
--   4. user_permissions seed — participate_work / dispatch_work
-- ============================================================================

CREATE TABLE IF NOT EXISTS work_queue (
  id              TEXT PRIMARY KEY,
  task_type       TEXT NOT NULL,                       -- 'metadata' | 'transcode' | 'scrape'
  payload         TEXT NOT NULL,                       -- JSON blob (task-shaped)
  required_caps   TEXT,                                -- JSON array of capability strings; NULL = any
  priority        INTEGER NOT NULL DEFAULT 5,          -- 1..10, lower runs first
  status          TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'completed', 'failed', 'canceled')),
  claimed_by      TEXT,                                -- username of the browser node
  claimed_at      INTEGER,
  heartbeat_at    INTEGER,
  result_json     TEXT,                                -- successful payload (JSON)
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at      INTEGER,
  FOREIGN KEY (claimed_by) REFERENCES users(username) ON DELETE SET NULL
);

-- Pickup query: oldest queued row first, priority-respecting.
CREATE INDEX IF NOT EXISTS idx_work_pickup
  ON work_queue (priority, created_at) WHERE status = 'queued';

-- Heartbeat sweep: scheduled handler scans claimed rows whose heartbeat aged
-- past worker_claim_ttl_seconds.
CREATE INDEX IF NOT EXISTS idx_work_claimed
  ON work_queue (claimed_by, heartbeat_at) WHERE status = 'claimed';

-- --- feature_strings ---------------------------------------------------------
-- Whole subsystem can be killed without redeploying by flipping
-- worker_pool_enabled to '0'. The other three are tunables.
INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('worker_pool_enabled',          '1',   'Whether the browser work pool is active (0|1)', unixepoch()),
  ('worker_poll_interval_seconds', '300', 'Client poll interval in seconds (default 5 min)', unixepoch()),
  ('worker_batch_size',            '5',   'Max tasks returned per /work/poll call',          unixepoch()),
  ('worker_claim_ttl_seconds',     '60',  'Heartbeat timeout before stale claim is re-queued', unixepoch());

-- --- user_permissions seed ---------------------------------------------------
-- participate_work: who is allowed to BE a worker node (level ≥ 2 by default).
-- dispatch_work:    who can POST /work/dispatch new tasks (super admin only).
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  (3, 'participate_work', 1, 0),
  (2, 'participate_work', 1, 0),
  (1, 'participate_work', 0, 0),
  (0, 'participate_work', 0, 0),
  (3, 'dispatch_work',    1, 0),
  (2, 'dispatch_work',    0, 0),
  (1, 'dispatch_work',    0, 0),
  (0, 'dispatch_work',    0, 0);
