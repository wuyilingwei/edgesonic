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
export async function getEffectivePermissions(
  env: { DB: D1Database; PERMISSIONS_OVERRIDE?: string },
  user: User,
): Promise<Record<string, boolean>> {
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

  perms["manage_permissions"] = user.level === 3;
  return perms;
}

export async function hasPermission(
  env: { DB: D1Database; PERMISSIONS_OVERRIDE?: string },
  user: User,
  permission: string,
): Promise<boolean> {
  // manage_permissions is deliberately never toggleable — neither via the
  // D1 user_permissions row nor the PERMISSIONS_OVERRIDE env cache. If it
  // were an ordinary row, a bad manual SQL edit, a stale env push, or a
  // future UI regression could hand a level < 3 caller the ability to grant
  // itself (or anyone else) more permissions. Hardcode it to level 3 so
  // this specific escalation path can't exist regardless of what's stored.
  if (permission === "manage_permissions") return user.level === 3;

  const override = readOverride(env);
  const overridden = override?.[String(user.level)]?.[permission];
  if (typeof overridden === "boolean") return overridden;

  const row = await env.DB
    .prepare(
      "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?",
    )
    .bind(user.level, permission)
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}
