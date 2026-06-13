-- ============================================================================
-- 0022: 065 — Cross-Origin Isolation feature flag
-- ============================================================================
-- COOP/COEP/CORP response headers light up `crossOriginIsolated = true` in
-- the browser, which is the prerequisite for SharedArrayBuffer and therefore
-- ffmpeg.wasm multi-threaded paths. The whole subsystem is gated by a single
-- feature_strings row so an admin can kill it without redeploying if a
-- cross-origin embed unexpectedly trips the new CORP constraint.
--
--   '1' → middleware sets:
--           Cross-Origin-Opener-Policy:   same-origin
--           Cross-Origin-Embedder-Policy: require-corp
--           Cross-Origin-Resource-Policy: same-origin  (default, when unset)
--   '0' → middleware skips entirely (pre-065 behaviour)
-- ============================================================================

INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES
  ('enable_cross_origin_isolation',
   '1',
   'COOP/COEP response headers — required for SharedArrayBuffer + ffmpeg.wasm multi-thread. 0|1.',
   unixepoch());
