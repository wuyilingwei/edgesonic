-- 087 — Admin permissions migration.
--
-- Unifies the security model: every super-admin / cross-user data path that
-- still hardcoded `if (user.level < N) return 403` now flows through
-- permissionMiddleware("<permission>") against the user_permissions table.
--
-- New permissions added here:
--   manage_cloudflare      — 054 CF API integration (cf.ts 6 endpoints)
--   maintenance_cleanup    — 078 cleanupDuplicateCovers
--   maintenance_reclaim    — 080 reclaimStaleWork
--   maintenance_reset      — 082 resetFailedWork
--   view_all_users_items   — cross-user data visibility (playlists / shares /
--                            now_playing — admin can see/manage others' items)
--
-- Already-present permissions reused unchanged:
--   dispatch_work          052a — also gates /work/status and /work/cancel
--   manage_users           0001 — gates cross-user changePassword + setAvatar
--   manage_sources         0001 — gates /sources/migratePasswords (redundant
--                                 inline level check removed in code)
--
-- All new rows use INSERT OR IGNORE so re-running the migration is idempotent.
-- Defaults follow the existing pattern: super-admin (L3) gets 1, everyone else
-- gets 0. Admins (L2) can be granted these later via the Permissions UI if the
-- operator wants to delegate, but the default keeps blast radius small.
INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES
  -- Cloudflare integration (054)
  (3, 'manage_cloudflare',      1, NULL),
  (2, 'manage_cloudflare',      0, NULL),
  (1, 'manage_cloudflare',      0, NULL),
  (0, 'manage_cloudflare',      0, NULL),
  -- Maintenance tooling (078 / 080 / 082)
  (3, 'maintenance_cleanup',    1, NULL),
  (2, 'maintenance_cleanup',    0, NULL),
  (1, 'maintenance_cleanup',    0, NULL),
  (0, 'maintenance_cleanup',    0, NULL),
  (3, 'maintenance_reclaim',    1, NULL),
  (2, 'maintenance_reclaim',    0, NULL),
  (1, 'maintenance_reclaim',    0, NULL),
  (0, 'maintenance_reclaim',    0, NULL),
  (3, 'maintenance_reset',      1, NULL),
  (2, 'maintenance_reset',      0, NULL),
  (1, 'maintenance_reset',      0, NULL),
  (0, 'maintenance_reset',      0, NULL),
  -- Cross-user data visibility (admin sees other users' items)
  (3, 'view_all_users_items',   1, NULL),
  (2, 'view_all_users_items',   0, NULL),
  (1, 'view_all_users_items',   0, NULL),
  (0, 'view_all_users_items',   0, NULL);
