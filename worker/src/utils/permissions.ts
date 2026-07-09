//
// Most endpoints guard themselves with `permissionMiddleware("<perm>")` which
// short-circuits to 403 when the row is missing or disabled. But a handful of
// users' playlists, a regular user sees only their own; the handler logic
// branches on the boolean and the underlying query changes.
//
// For those cases use `hasPermission(db, user, perm)` instead of duplicating
// permissionMiddleware's SQL. The shape mirrors the middleware's read so the
// two paths behave identically: a missing row is treated as `enabled=0`.
//
// Why a separate helper and not import the middleware's SQL? The middleware
// is wrapped in Hono's createMiddleware factory and writes to the response,
// which doesn't compose with "ask if the caller has X and branch on it" use
// cases (shares.ts getSharesForUser(isAdmin) / playlists visibility / now_
// playing visibility filter / setAvatar cross-user / changePassword cross-
// user).
//
// Cache layer (later): if D1 latency becomes a problem we can add a per-
// request memo on c.get("user") — the helper signature stays the same so the
// callers don't change.

import type { User } from "../types/entities";

export async function hasPermission(
  db: D1Database,
  user: User,
  permission: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?",
    )
    .bind(user.level, permission)
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}
