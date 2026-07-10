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

﻿// 106 鈥?Subsonic 1.16.1 user management endpoints, exposed at /rest/*.
//
// 055 moved the CRUD to /edgesonic/users/* (JSON, web-UI only). This file
// restores the Subsonic-protocol surface so Subsonic clients (DSub admin
// panel, Submariner, etc.) can call /rest/getUser, /rest/getUsers,
// /rest/createUser, /rest/updateUser, /rest/deleteUser.
//
// Auth: same permission gating as the /edgesonic equivalents 鈥?manage_users
// for CUD, any authenticated user for getUser (Subsonic spec allows a user
// to query themselves). Session-only guard on CUD is NOT applied (Subsonic
// clients auth with token+salt, not web sessions) 鈥?manage_users permission
// is the real gate.
//
// Response shape: Subsonic XML (subsonicOK / subsonicError), NOT JSON.

import { Hono } from "hono";
import type { Context } from "hono";
import { permissionMiddleware, sha256, subsonicError } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const subsonicUserRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

type C = Context<{ Bindings: Env; Variables: { user: User } }>;

// Mirrors the same constraint in endpoints/edgesonic/users.ts — admin/
// super-admin accounts can only be created, edited, or removed by a
// super-admin, not by any manage_users holder (grantable down to level 1).
const ADMIN_TIER_LEVEL = 2;

// Read a body field from either the query string or a POST form body. Subsonic
// clients send params as query (?username=...) or form fields (POST body).
async function readParam(c: C, name: string): Promise<string | undefined> {
  const q = c.req.query(name);
  if (q !== undefined) return q;
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      const raw = body[name];
      if (raw !== undefined) return Array.isArray(raw) ? String(raw[0]) : String(raw);
    } catch {
      // body wasn't form-encoded 鈥?fall through
    }
  }
  return undefined;
}

function parseIntOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Map EdgeSonic level (0=guest,1=user,2=admin,3=superadmin) 鈫?Subsonic role
// booleans. Subsonic uses adminRole / settingsRole / downloadRole etc.; we
// expose the commonly-used subset.
function levelToRoles(level: number): Record<string, string> {
  return {
    adminRole: level >= 2 ? "true" : "false",
    settingsRole: level >= 2 ? "true" : "false",
    downloadRole: "true",
    uploadRole: "true",
    playlistRole: "true",
    coverArtRole: "true",
    commentRole: "true",
    podcastRole: level >= 2 ? "true" : "false",
    streamRole: "true",
    jukeboxRole: "false",
    shareRole: "true",
  };
}

// Subsonic spec: getUser(username?) 鈥?if omitted, returns the authenticated user.
const getUserHandler = async (c: C): Promise<Response> => {
  const caller = c.get("user") as User;
  const username = await readParam(c, "username");
  const target = username || caller.username;

  const db = c.env.DB;
  const row = await db
    .prepare("SELECT username, level, enabled FROM users WHERE username = ?")
    .bind(target)
    .first<{ username: string; level: number; enabled: number }>();
  if (!row) {
    return c.text(subsonicError(70, "User not found"), 404, XML);
  }

  // Non-admin querying another user 鈫?deny (Subsonic convention).
  if (target !== caller.username) {
    const canManage = await hasPermission(c.env, caller, "manage_users");
    if (!canManage) {
      return c.text(subsonicError(50, "Not authorized to view other users"), 403, XML);
    }
  }

  return c.text(
    subsonicOK({
        user: {
          _attributes: {
            username: row.username,
            email: "",
            scrobblingEnabled: "true",
            adminRole: row.level >= 2 ? "true" : "false",
            settingsRole: row.level >= 2 ? "true" : "false",
            downloadRole: "true",
            uploadRole: "true",
            playlistRole: "true",
            coverArtRole: "true",
            commentRole: "true",
          podcastRole: row.level >= 2 ? "true" : "false",
          streamRole: "true",
          jukeboxRole: "false",
          shareRole: "true",
          maxBitRate: "0",
          folder: "0",
        },
      },
    }),
    200, XML,
  );
};

const getUsersHandler = async (c: C): Promise<Response> => {
  const db = c.env.DB;
  const result = await db
    .prepare("SELECT username, level, enabled FROM users ORDER BY created_at ASC")
    .all<{ username: string; level: number; enabled: number }>();

  return c.text(
    subsonicOK({
      users: {
        user: result.results.map((u) => ({
          _attributes: {
            username: u.username,
            ...levelToRoles(u.level),
          },
        })),
      },
    }),
    200, XML,
  );
};

const createUserHandler = async (c: C): Promise<Response> => {
  const caller = c.get("user") as User;
  const db = c.env.DB;

  const username = await readParam(c, "username");
  const password = await readParam(c, "password");
  // Subsonic uses adminRole / settingsRole booleans; we map to level.
  const adminRole = (await readParam(c, "adminRole")) === "true";
  const levelParam = parseIntOrNull(await readParam(c, "level"));
  const level = levelParam !== null ? levelParam : adminRole ? 2 : 1;

  if (!username || !password) {
    return c.text(subsonicError(10, "Missing username or password"), 400, XML);
  }
  if (level < 0 || level > 3) {
    return c.text(subsonicError(10, "Invalid level (0-3)"), 400, XML);
  }

  // Permission gate (the permissionMiddleware for manage_users is NOT applied
  // here because Subsonic CUD endpoints use token auth, not sessions; we gate
  // inline so the route is reachable by token+salt clients).
  const canManage = await hasPermission(c.env, caller, "manage_users");
  if (!canManage) {
    return c.text(subsonicError(50, "manage_users permission required"), 403, XML);
  }
  if (level >= ADMIN_TIER_LEVEL && caller.level < 3) {
    return c.text(subsonicError(50, "Only a super-admin can create admin/super-admin accounts"), 403, XML);
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT OR REPLACE INTO users (username, master_password, level, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    )
    .bind(username, await sha256(password), level, now, now)
    .run();

  return c.text(subsonicOK({}), 200, XML);
};

const updateUserHandler = async (c: C): Promise<Response> => {
  const caller = c.get("user") as User;
  const db = c.env.DB;

  const username = await readParam(c, "username");
  if (!username) {
    return c.text(subsonicError(10, "Missing username"), 400, XML);
  }

  const canManage = await hasPermission(c.env, caller, "manage_users");
  if (!canManage) {
    return c.text(subsonicError(50, "manage_users permission required"), 403, XML);
  }

  const password = await readParam(c, "password");
  const levelParam = parseIntOrNull(await readParam(c, "level"));
  const enabledParam = await readParam(c, "enabled");

  const now = Math.floor(Date.now() / 1000);

  // Constraint B 鈥?an admin cannot promote themselves to superadmin.
  if (levelParam !== null && levelParam >= 3 && caller.username === username) {
    return c.text(subsonicError(0, "Cannot promote yourself to superadmin"), 200, XML);
  }

  // Constraint C 鈥?manage_users below super-admin can't touch an existing
  // admin/super-admin account or promote anyone into the admin tier.
  const existingTarget = await db
    .prepare("SELECT level FROM users WHERE username = ?")
    .bind(username)
    .first<{ level: number }>();
  const targetIsOrBecomesAdminTier =
    (existingTarget && existingTarget.level >= ADMIN_TIER_LEVEL) ||
    (levelParam !== null && levelParam >= ADMIN_TIER_LEVEL);
  if (targetIsOrBecomesAdminTier && caller.level < 3) {
    return c.text(subsonicError(50, "Only a super-admin can manage admin/super-admin accounts"), 403, XML);
  }

  if (password) {
    await db
      .prepare("UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?")
      .bind(await sha256(password), now, username)
      .run();
  }
  if (levelParam !== null) {
    if (levelParam < 0 || levelParam > 3) {
      return c.text(subsonicError(10, "Invalid level (0-3)"), 400, XML);
    }
    // Constraint A 鈥?keep at least one superadmin.
    if (levelParam < 3 && existingTarget?.level === 3) {
      const cnt = await db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE level = 3 AND enabled = 1")
        .first<{ cnt: number }>();
      if ((cnt?.cnt ?? 0) <= 1) {
        return c.text(subsonicError(0, "Must keep at least one superadmin"), 200, XML);
      }
    }
    await db
      .prepare("UPDATE users SET level = ?, updated_at = ? WHERE username = ?")
      .bind(levelParam, now, username)
      .run();
  }
  if (enabledParam !== undefined) {
    const enabled = enabledParam === "true" || enabledParam === "1";
    if (!enabled && existingTarget?.level === 3) {
      const cnt = await db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE level = 3 AND enabled = 1")
        .first<{ cnt: number }>();
      if ((cnt?.cnt ?? 0) <= 1) {
        return c.text(subsonicError(0, "Must keep at least one superadmin"), 200, XML);
      }
    }
    await db
      .prepare("UPDATE users SET enabled = ?, updated_at = ? WHERE username = ?")
      .bind(enabled ? 1 : 0, now, username)
      .run();
  }

  return c.text(subsonicOK({}), 200, XML);
};

const deleteUserHandler = async (c: C): Promise<Response> => {
  const caller = c.get("user") as User;
  const db = c.env.DB;

  const username = await readParam(c, "username");
  if (!username) {
    return c.text(subsonicError(10, "Missing username"), 400, XML);
  }

  const canManage = await hasPermission(c.env, caller, "manage_users");
  if (!canManage) {
    return c.text(subsonicError(50, "manage_users permission required"), 403, XML);
  }

  const target = await db
    .prepare("SELECT level FROM users WHERE username = ?")
    .bind(username)
    .first<{ level: number }>();
  // Constraint C 鈥?manage_users below super-admin can't remove an
  // admin/super-admin account.
  if (target && target.level >= ADMIN_TIER_LEVEL && caller.level < 3) {
    return c.text(subsonicError(50, "Only a super-admin can delete admin/super-admin accounts"), 403, XML);
  }
  // Constraint A 鈥?keep at least one superadmin.
  if (target && target.level === 3) {
    const cnt = await db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE level = 3 AND enabled = 1")
      .first<{ cnt: number }>();
    if ((cnt?.cnt ?? 0) <= 1) {
      return c.text(subsonicError(0, "Must keep at least one superadmin"), 200, XML);
    }
  }

  await db.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration 鈥?Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: C) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    subsonicUserRoutes.get(p, handler);
    subsonicUserRoutes.post(p, handler);
  }
}

// getUsers / getUser are read-only; gated inline by hasPermission.
register("getUser", getUserHandler);
register("getUsers", getUsersHandler);
// CUD endpoints gated inline by hasPermission("manage_users").
register("createUser", createUserHandler);
register("updateUser", updateUserHandler);
register("deleteUser", deleteUserHandler);
