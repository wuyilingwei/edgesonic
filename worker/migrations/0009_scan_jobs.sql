-- ============================================================================
-- 0006: scan_jobs — persisted background scan tracking for startScan / getScanStatus
-- ============================================================================
-- Each invocation of /rest/startScan inserts one row per source; the scan
-- itself runs in ctx.waitUntil and updates scanned_items as it progresses.
-- getScanStatus aggregates the most recent jobs across all sources.
-- ============================================================================
CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  FOREIGN KEY (source_id) REFERENCES storage_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_source_started ON scan_jobs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status);
