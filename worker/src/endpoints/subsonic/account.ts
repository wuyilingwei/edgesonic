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

// 055 — Account-level Subsonic protocol endpoints (changePassword, getAvatar).
// Lives in the subsonic bucket because they are part of the Subsonic 1.16.1 /
// OpenSubsonic surface and must remain at /rest/*.
//
// Auth: changePassword is pinned to a web-session credential by auth.ts so a
// leaked subsonic_credentials / apiKey can't rotate the master password.
// getAvatar is open to any authenticated user (it just streams the binary).
import { Hono } from "hono";
import { subsonicError, sha256 } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const accountRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const changePasswordHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const qUsername = c.req.query("username");
  const qPassword = c.req.query("password");
  let username = qUsername;
  let password = qPassword;
  if (!username || !password) {
    const body = await c.req.json<{ username?: string; password?: string }>()
      .catch(() => ({} as { username?: string; password?: string }));
    username = username || body.username;
    password = password || body.password;
  }
  if (!username || !password) {
    return c.text(subsonicError(10, "Missing username or password"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const caller = c.get("user");
  const isSelf = caller.username === username;
  if (!isSelf && caller.level < 3) {
    return c.text(subsonicError(50, "Not authorized to change another user's password"), 403, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const db = c.env.DB;
  const target = await db
    .prepare("SELECT username FROM users WHERE username = ?")
    .bind(username)
    .first<{ username: string }>();
  if (!target) {
    return c.text(subsonicError(70, "User not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  await db
    .prepare("UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?")
    .bind(await sha256(password), Math.floor(Date.now() / 1000), username)
    .run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
};

accountRoutes.get("/changePassword", changePasswordHandler);
accountRoutes.get("/changePassword.view", changePasswordHandler);
accountRoutes.post("/changePassword", changePasswordHandler);
accountRoutes.post("/changePassword.view", changePasswordHandler);

const getAvatarHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const username = c.req.query("username");
  if (!username) {
    return c.text(subsonicError(10, "Missing username"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = c.env.DB;
  const row = await db
    .prepare("SELECT avatar_r2_key FROM users WHERE username = ?")
    .bind(username)
    .first<{ avatar_r2_key: string | null }>();
  if (!row || !row.avatar_r2_key) {
    return c.text(subsonicError(70, "Avatar not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const r2 = c.env.MUSIC_BUCKET;
  const obj = await r2.get(row.avatar_r2_key);
  if (!obj) {
    return c.text(subsonicError(70, "Avatar not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const contentType =
    obj.httpMetadata?.contentType
    ?? (row.avatar_r2_key.endsWith(".png") ? "image/png" : "image/jpeg");
  return new Response(obj.body, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
  });
};

accountRoutes.get("/getAvatar", getAvatarHandler);
accountRoutes.get("/getAvatar.view", getAvatarHandler);
