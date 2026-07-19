// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

//
// Most endpoints guard themselves with `permissionMiddleware("<perm>")` which
// short-circuits to 403 when the row is missing or disabled. But a handful of
// users' playlists, a regular user sees only their own; the handler logic
// branches on the boolean and the underlying query changes.
//
// For those cases use `hasPermission(env, user, perm)` instead of duplicating
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
// Cache layer: PERMISSIONS_OVERRIDE (see readOverride below) now
// serves reads before D1 is ever touched, avoiding a D1 round-trip on every
// permission check when the admin has saved the matrix at least once.

import type { User } from "../types/entities";

type PermissionUser = Pick<User, "level">;

// Permission checks now prefer a runtime env-var cache over D1.
// PERMISSIONS_OVERRIDE (pushed via POST /edgesonic/permissions/save using
// the same CF-API-secret-write pattern as CF_API_TOKEN, see
// endpoints/edgesonic/permissions.ts) holds the whole matrix as
// `{ [level]: { [permission]: boolean } }`. When present and it has an
// entry for the requested (level, permission) pair, that value wins — no D1
// round-trip. Anything else (unset, malformed JSON, or simply missing that
// specific key) falls through to the D1 user_permissions table, which stays
// the durable source of truth and the fallback path.
function readOverride(env: { PERMISSIONS_OVERRIDE?: string }): Record<string, Record<string, boolean>> | null {
  if (!env.PERMISSIONS_OVERRIDE) return null;
  try {
    const parsed = JSON.parse(env.PERMISSIONS_OVERRIDE);
    return parsed && typeof parsed === "object" ? parsed as Record<string, Record<string, boolean>> : null;
  } catch {
    return null;
  }
}

// Whole effective permission map for a user's level, used by the SPA to gate
// navigation and settings by real capability (GET /edgesonic/auth/me). Same
// precedence as hasPermission: D1 rows for the level are the base, the
// PERMISSIONS_OVERRIDE env cache wins per-key, and manage_permissions is
// hardcoded to level 3.
// All known permission keys. Super admin (level 3) gets every one of them
// unconditionally — see getEffectivePermissions / hasPermission.
const ALL_PERMISSIONS = [
  "stream", "download", "upload", "delete", "edit_tags",
  "manage_files", "manage_sources", "manage_credentials", "manage_users",
  "manage_permissions", "manage_settings", "maintenance_cleanup",
  "maintenance_reclaim", "maintenance_reset", "browse", "search",
  "participate_work", "dispatch_work", "share", "manage_playlists",
  "manage_podcasts", "manage_radio", "manage_cloudflare", "edit_annotations",
] as const;

// ----------------------------------------------------------------------------
// Hardlocked permissions — cannot be enabled for the given level via the
// matrix UI, the /permissions/save API, direct D1 UPDATE, or the
// PERMISSIONS_OVERRIDE env cache. Enforced both at write time (permissions.ts)
// and at read time (below) so a stray SQL edit or a stale override cannot
// hand a guest an edit/admin capability, and a user cannot self-elevate to a
// management role. Super admin (level 3) is always short-circuited above and
// is never subject to these locks.
// ----------------------------------------------------------------------------
// Guest (level 0): web-only playback. Only stream/browse/search may ever be
// enabled. Everything else is permanently off.
export const GUEST_ALLOWED_PERMS = new Set(["stream", "browse", "search"]);
// User (level 1): may download/upload/scrobble-like actions, but never any
// management/admin/maintenance surface. These would either escalate a user
// into an admin-shaped role or expose destructive operations.
export const USER_LOCKED_PERMS = new Set([
  "manage_users", "manage_credentials", "manage_permissions", "manage_settings",
  "manage_cloudflare", "manage_sources", "maintenance_cleanup",
  "maintenance_reclaim", "maintenance_reset", "dispatch_work",
  "view_all_users_items",
]);

function isHardlocked(level: number, permission: string): boolean {
  if (level === 0) return !GUEST_ALLOWED_PERMS.has(permission);
  if (level === 1) return USER_LOCKED_PERMS.has(permission);
  return false;
}

export function isPermissionHardlocked(level: number, permission: string): boolean {
  return isHardlocked(level, permission);
}

export async function getEffectivePermissions(
  env: { DB: D1Database; PERMISSIONS_OVERRIDE?: string },
  user: User,
): Promise<Record<string, boolean>> {
  // Super admin (level 3) always holds every permission, regardless of what
  // the D1 rows or PERMISSIONS_OVERRIDE say. The matrix UI hides the level 3
  // card entirely, so the row state for level 3 is cosmetic at best and a
  // privilege-denial footgun at worst (a stale override or manual SQL edit
  // could otherwise lock the super admin out of their own admin surface).
  if (user.level === 3) {
    const perms: Record<string, boolean> = {};
    for (const k of ALL_PERMISSIONS) perms[k] = true;
    return perms;
  }

  const rows = await env.DB
    .prepare("SELECT permission, enabled FROM user_permissions WHERE level = ?")
    .bind(user.level)
    .all<{ permission: string; enabled: number }>();
  const perms: Record<string, boolean> = {};
  for (const r of rows.results) perms[r.permission] = r.enabled === 1;

  const override = readOverride(env)?.[String(user.level)];
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (typeof v === "boolean") perms[k] = v;
    }
  }

  // Read-time enforcement of hardlocked permissions: regardless of what D1 or
  // the override says, guest's non-{stream,browse,search} perms and user's
  // management/maintenance perms are forced off. This is the safety net behind
  // the write-time guard in permissions.ts; if a direct SQL edit or a stale
  // PERMISSIONS_OVERRIDE ever lands one of these rows in an "enabled" state,
  // it never surfaces as a real capability.
  for (const k of Object.keys(perms)) {
    if (perms[k] && isHardlocked(user.level, k)) perms[k] = false;
  }

  perms["manage_permissions"] = user.level === 3;
  return perms;
}

export async function hasPermission(
  env: { DB: D1Database; PERMISSIONS_OVERRIDE?: string },
  user: PermissionUser,
  permission: string,
): Promise<boolean> {
  // manage_permissions is deliberately never toggleable — neither via the
  // D1 user_permissions row nor the PERMISSIONS_OVERRIDE env cache. If it
  // were an ordinary row, a bad manual SQL edit, a stale env push, or a
  // future UI regression could hand a level < 3 caller the ability to grant
  // itself (or anyone else) more permissions. Hardcode it to level 3 so
  // this specific escalation path can't exist regardless of what's stored.
  if (permission === "manage_permissions") return user.level === 3;

  // Super admin (level 3) always has every permission — same rationale as
  // getEffectivePermissions above. The matrix UI never writes to level 3,
  // but a stale PERMISSIONS_OVERRIDE or direct D1 edit could otherwise deny
  // the super admin a capability they need to recover the system.
  if (user.level === 3) return true;

  // Hardlocked perms — read-time enforcement mirroring getEffectivePermissions.
  // A guest asking for anything beyond stream/browse/search, or a user asking
  // for any management/maintenance perm, is denied without consulting D1 or
  // the override, so a stray write can never escalate into a real capability.
  if (isHardlocked(user.level, permission)) return false;

  const override = readOverride(env);
  const overridden = override?.[String(user.level)]?.[permission];
  if (typeof overridden === "boolean") {
    // Even the override cannot unlock a hardlocked perm.
    if (overridden && isHardlocked(user.level, permission)) return false;
    return overridden;
  }

  const row = await env.DB
    .prepare(
      "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?",
    )
    .bind(user.level, permission)
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}
