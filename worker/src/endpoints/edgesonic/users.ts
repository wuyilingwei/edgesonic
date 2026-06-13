// 055 — User CRUD. Split out of the old endpoints/admin.ts. Subsonic-style XML
// envelopes are kept verbatim so the front-end doesn't have to relearn the
// response shape during the API refactor.
import { Hono } from "hono";
import { permissionMiddleware, subsonicError, sha256 } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const usersRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

usersRoutes.get("/users/list", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const result = await db.prepare("SELECT username, level, enabled FROM users ORDER BY created_at ASC").all<{
    username: string; level: number; enabled: number;
  }>();
  const users = result.results.map((u) => ({
    _attributes: {
      username: u.username, level: String(u.level),
      enabled: String(!!u.enabled),
    },
  }));
  return c.text(subsonicOK({ users: { user: users } }), 200, XML);
});

usersRoutes.post("/users/create", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password: string; level?: number }>();
  if (!body.username || !body.password) {
    return c.text(subsonicError(0, "Missing username or password"), 400, XML);
  }
  const level = body.level ?? 1;
  if (level < 0 || level > 3) {
    return c.text(subsonicError(0, "Invalid level (0-3)"), 400, XML);
  }
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT OR REPLACE INTO users (username, master_password, level, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).bind(body.username, await sha256(body.password), level, now, now).run();
  return c.text(subsonicOK({}), 200, XML);
});

usersRoutes.get("/users/get", async (c) => {
  const username = c.req.query("username");
  if (!username) {
    return c.text(subsonicError(0, "Missing username"), 400, XML);
  }
  const db = c.env.DB;
  const user = await db.prepare(
    "SELECT username, level, enabled FROM users WHERE username = ?"
  ).bind(username).first<{ username: string; level: number; enabled: number }>();
  if (!user) {
    return c.text(subsonicError(0, "User not found"), 404, XML);
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
    200, XML,
  );
});

usersRoutes.post("/users/update", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password?: string; level?: number; enabled?: number }>();
  if (!body.username) {
    return c.text(subsonicError(0, "Missing username"), 400, XML);
  }
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  if (body.password) {
    await db.prepare(
      "UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?"
    ).bind(await sha256(body.password), now, body.username).run();
  }
  if (body.level !== undefined) {
    if (body.level < 0 || body.level > 3) {
      return c.text(subsonicError(0, "Invalid level (0-3)"), 400, XML);
    }
    await db.prepare(
      "UPDATE users SET level = ?, updated_at = ? WHERE username = ?"
    ).bind(body.level, now, body.username).run();
  }
  if (body.enabled !== undefined) {
    await db.prepare(
      "UPDATE users SET enabled = ?, updated_at = ? WHERE username = ?"
    ).bind(body.enabled ? 1 : 0, now, body.username).run();
  }
  return c.text(subsonicOK({}), 200, XML);
});

usersRoutes.post("/users/delete", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string }>();
  if (!body.username) {
    return c.text(subsonicError(0, "Missing username"), 400, XML);
  }
  const db = c.env.DB;
  await db.prepare("DELETE FROM users WHERE username = ?").bind(body.username).run();
  return c.text(subsonicOK({}), 200, XML);
});
