import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { permissionMiddleware, subsonicError, sha256 } from "../auth";
import { subsonicOK } from "../utils/xml";

export const adminRoutes = new Hono<{ Bindings: Env; Variables: { user: import("../types/entities").User } }>();

adminRoutes.get("/rest/getStorageSources", permissionMiddleware("manage_sources"), async (c) => {
  const db = (c.env as Env).DB;
  const result = await db.prepare("SELECT * FROM storage_sources ORDER BY created_at ASC").all<{
    id: string; type: string; base_url: string; username: string | null;
    root_path: string | null; last_sync: number | null; enabled: number;
  }>();
  const sources = result.results.map((s) => ({
    _attributes: {
      id: s.id, type: s.type, baseUrl: s.base_url,
      rootPath: s.root_path ?? "",
      username: s.username ?? "", enabled: String(!!s.enabled),
      lastSync: s.last_sync ? String(s.last_sync) : "0",
    },
  }));
  return c.text(subsonicOK({ storageSources: { source: sources } }), 200, {
    "Content-Type": "application/xml; charset=UTF-8",
  });
});

adminRoutes.post("/rest/addStorageSource", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ type: string; base_url: string; username?: string; password?: string; root_path?: string }>();
  if (!body.type || !body.base_url) {
    return c.text(subsonicError(0, "Missing type or base_url"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const id = crypto.randomUUID().substring(0, 8);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO storage_sources (id, type, base_url, username, password, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, body.type, body.base_url, body.username || null, body.password || null, body.root_path || "", now, now).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

adminRoutes.post("/rest/updateStorageSource", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    id: string; base_url?: string; username?: string; password?: string;
    root_path?: string; enabled?: number;
  }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.base_url !== undefined) { sets.push("base_url = ?"); binds.push(body.base_url); }
  if (body.username !== undefined) { sets.push("username = ?"); binds.push(body.username || null); }
  if (body.password !== undefined && body.password !== "") { sets.push("password = ?"); binds.push(body.password); }
  if (body.root_path !== undefined) { sets.push("root_path = ?"); binds.push(body.root_path); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0); }
  if (sets.length === 0) {
    return c.text(subsonicError(0, "Nothing to update"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000), body.id);
  const result = await db.prepare(`UPDATE storage_sources SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (!result.meta.changes) {
    return c.text(subsonicError(70, "Source not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
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
    "INSERT OR REPLACE INTO users (username, master_password, level, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).bind(body.username, await sha256(body.password), level, now, now).run();
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

adminRoutes.post("/rest/updateUser", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password?: string; level?: number; enabled?: number }>();
  if (!body.username) {
    return c.text(subsonicError(0, "Missing username"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const now = Math.floor(Date.now() / 1000);

  if (body.password) {
    await db.prepare(
      "UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?"
    ).bind(await sha256(body.password), now, body.username).run();
  }
  if (body.level !== undefined) {
    if (body.level < 0 || body.level > 3) {
      return c.text(subsonicError(0, "Invalid level (0-3)"), 400, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
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
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

adminRoutes.post("/rest/deleteUser", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string }>();
  if (!body.username) {
    return c.text(subsonicError(0, "Missing username"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  await db.prepare("DELETE FROM users WHERE username = ?").bind(body.username).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

adminRoutes.post("/rest/deleteStorageSource", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  await db.prepare("DELETE FROM storage_sources WHERE id = ?").bind(body.id).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

// === Permission Management (Level 3 only) ===

adminRoutes.get("/rest/getPermissions", permissionMiddleware("manage_permissions"), async (c) => {
  const db = (c.env as Env).DB;
  const rows = await db.prepare(
    "SELECT level, permission, enabled, max_rph FROM user_permissions ORDER BY level ASC, permission ASC"
  ).all<{ level: number; permission: string; enabled: number; max_rph: number }>();

  const grouped: Record<number, Array<{ permission: string; enabled: number; max_rph: number }>> = {};
  for (const r of rows.results) {
    if (!grouped[r.level]) grouped[r.level] = [];
    grouped[r.level].push({ permission: r.permission, enabled: r.enabled, max_rph: r.max_rph });
  }

  return c.text(
    subsonicOK({
      permissions: Object.entries(grouped).map(([level, perms]) => ({
        _attributes: { level },
        permission: perms.map((p) => ({
          _attributes: {
            name: p.permission,
            enabled: String(p.enabled),
            maxRph: String(p.max_rph),
          },
        })),
      })),
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

adminRoutes.post("/rest/updatePermission", permissionMiddleware("manage_permissions"), async (c) => {
  const body = await c.req.json<{ level: number; permission: string; enabled?: number; max_rph?: number }>();
  if (body.level === undefined || !body.permission) {
    return c.text(subsonicError(0, "Missing level or permission"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  if (body.level < 0 || body.level > 3) {
    return c.text(subsonicError(0, "Invalid level (0-3)"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;

  if (body.enabled !== undefined) {
    await db.prepare(
      "UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?"
    ).bind(body.enabled ? 1 : 0, body.level, body.permission).run();
  }
  if (body.max_rph !== undefined) {
    await db.prepare(
      "UPDATE user_permissions SET max_rph = ? WHERE level = ? AND permission = ?"
    ).bind(body.max_rph, body.level, body.permission).run();
  }

  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

// === Guest Token Management ===

adminRoutes.post("/rest/createGuestToken", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ expiresIn?: number }>();
  const db = (c.env as Env).DB;
  const user = c.get("user");
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + (body.expiresIn || 86400); // default 24h

  await db.prepare(
    "INSERT INTO guest_tokens (token, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(token, user.username, expiresAt, Math.floor(Date.now() / 1000)).run();

  return c.text(
    subsonicOK({
      guestToken: {
        _attributes: {
          token,
          expiresAt: String(expiresAt),
        },
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

// === Subsonic Credential Management ===

adminRoutes.get("/rest/getCredentials", permissionMiddleware("manage_credentials"), async (c) => {
  const db = (c.env as Env).DB;
  const user = c.get("user");
  const rows = await db.prepare(
    "SELECT id, label, last_used, created_at FROM subsonic_credentials WHERE username = ? ORDER BY created_at ASC"
  ).bind(user.username).all<{ id: string; label: string | null; last_used: number | null; created_at: number }>();

  return c.text(
    subsonicOK({
      subsonicCredentials: {
        credential: rows.results.map((r) => ({
          _attributes: {
            id: r.id,
            label: r.label || "",
            lastUsed: r.last_used ? String(r.last_used) : "0",
            createdAt: String(r.created_at),
          },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

adminRoutes.post("/rest/createCredential", permissionMiddleware("manage_credentials"), async (c) => {
  const db = (c.env as Env).DB;
  const user = c.get("user");

  // Check limit: max 64 per user
  const count = await db.prepare(
    "SELECT COUNT(*) AS cnt FROM subsonic_credentials WHERE username = ?"
  ).bind(user.username).first<{ cnt: number }>();
  if (count && count.cnt >= 64) {
    return c.text(subsonicError(0, "Maximum 64 Subsonic credentials per user"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const body = await c.req.json<{ password: string; label?: string }>();
  if (!body.password) {
    return c.text(subsonicError(0, "Missing password"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const id = crypto.randomUUID().substring(0, 12);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO subsonic_credentials (id, username, password, label, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, user.username, body.password, body.label || "", now).run();

  return c.text(
    subsonicOK({
      credential: { _attributes: { id, label: body.label || "" } },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

adminRoutes.post("/rest/deleteCredential", permissionMiddleware("manage_credentials"), async (c) => {
  const db = (c.env as Env).DB;
  const user = c.get("user");
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing credential id"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  await db.prepare(
    "DELETE FROM subsonic_credentials WHERE id = ? AND username = ?"
  ).bind(body.id, user.username).run();
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

// === Session Management ===

adminRoutes.get("/rest/getSessions", async (c) => {
  const db = (c.env as Env).DB;
  const user = c.get("user");
  const rows = await db.prepare(
    "SELECT id, user_agent, expires_at, created_at FROM sessions WHERE username = ? AND expires_at > ? ORDER BY created_at DESC"
  ).bind(user.username, Math.floor(Date.now() / 1000)).all<{ id: string; user_agent: string | null; expires_at: number; created_at: number }>();

  return c.text(
    subsonicOK({
      sessions: {
        session: rows.results.map((r) => ({
          _attributes: {
            id: r.id,
            userAgent: r.user_agent || "",
            expiresAt: String(r.expires_at),
            createdAt: String(r.created_at),
          },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

adminRoutes.post("/rest/revokeSession", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const db = (c.env as Env).DB;
  const kv = (c.env as Env).KV;
  const user = c.get("user");
  // Users may only revoke their own sessions
  const row = await db.prepare("SELECT token FROM sessions WHERE id = ? AND username = ?")
    .bind(body.id, user.username).first<{ token: string }>();
  if (!row) {
    return c.text(subsonicError(70, "Session not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(body.id).run();
  // Drop the KV fast-path cache if it pointed at this token
  const cached = await kv.get(`session:${user.username}`);
  if (cached === row.token) await kv.delete(`session:${user.username}`);
  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});
