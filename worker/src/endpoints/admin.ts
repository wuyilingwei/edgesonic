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
      "UPDATE users SET password = ?, updated_at = ? WHERE username = ?"
    ).bind(body.password, now, body.username).run();
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
