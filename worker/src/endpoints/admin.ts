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

import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { permissionMiddleware, subsonicError } from "../auth";
import { subsonicOK } from "../utils/xml";

export const adminRoutes = new Hono();

adminRoutes.get("/rest/getStorageSources", permissionMiddleware("manage_sources"), async (c) => {
  const db = (c.env as Env).DB;
  const result = await db.prepare("SELECT * FROM storage_sources ORDER BY created_at ASC").all<{
    id: string; type: string; base_url: string; username: string | null;
    last_sync: number | null; enabled: number;
  }>();
  const sources = result.results.map((s) => ({
    _attributes: {
      id: s.id, type: s.type, baseUrl: s.base_url,
      username: s.username ?? "", enabled: String(!!s.enabled),
      lastSync: s.last_sync ? String(s.last_sync) : "0",
    },
  }));
  return c.text(subsonicOK({ storageSources: { source: sources } }), 200, {
    "Content-Type": "application/xml; charset=UTF-8",
  });
});

adminRoutes.post("/rest/addStorageSource", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ type: string; base_url: string; username?: string; password?: string }>();
  if (!body.type || !body.base_url) {
    return c.text(subsonicError(0, "Missing type or base_url"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const id = crypto.randomUUID().substring(0, 8);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO storage_sources (id, type, base_url, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, body.type, body.base_url, body.username || null, body.password || null, now, now).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

adminRoutes.get("/rest/getUsers", permissionMiddleware("manage_users"), async (c) => {
  const db = (c.env as Env).DB;
  const result = await db.prepare("SELECT username, level, enabled FROM users ORDER BY created_at ASC").all<{
    username: string; level: number; enabled: number;
  }>();
  const users = result.results.map((u) => ({
    _attributes: {
      username: u.username, level: String(u.level),
      enabled: String(!!u.enabled),
    },
  }));
  return c.text(subsonicOK({ users: { user: users } }), 200, {
    "Content-Type": "application/xml; charset=UTF-8",
  });
});

adminRoutes.post("/rest/createUser", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password: string; level?: number }>();
  if (!body.username || !body.password) {
    return c.text(subsonicError(0, "Missing username or password"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const level = body.level ?? 1;
  if (level < 0 || level > 3) {
    return c.text(subsonicError(0, "Invalid level (0-3)"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT OR REPLACE INTO users (username, password, level, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).bind(body.username, body.password, level, now, now).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

adminRoutes.get("/rest/getUser", async (c) => {
  const username = c.req.query("username");
  if (!username) {
    return c.text(subsonicError(0, "Missing username"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const user = await db.prepare(
    "SELECT username, level, enabled FROM users WHERE username = ?"
  ).bind(username).first<{ username: string; level: number; enabled: number }>();
  if (!user) {
    return c.text(subsonicError(0, "User not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  return c.text(
    subsonicOK({
      user: {
        _attributes: {
          username: user.username,
          level: String(user.level),
          enabled: String(!!user.enabled),
        },
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});
