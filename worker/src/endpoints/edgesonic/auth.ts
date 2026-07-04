// 055 — EdgeSonic auth-management bucket: web login, session list, subsonic
// credentials, guest tokens. Login is the only route in this whole tree that
// runs *before* the global authMiddleware (it issues the session token used by
// every other endpoint in /tag /storage /edgesonic).
import { Hono } from "hono";
import { permissionMiddleware, subsonicError, sha256 } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

// 055 — The public web-login route. Lives outside authMiddleware (it's the
// only request that legitimately arrives without a session) and is exported
// separately so index.ts can mount it BEFORE the global auth filter at the
// /edgesonic/auth/login + /edgesonic/auth/logout paths.
export const webLoginRoutes = new Hono<{ Bindings: Env }>();

webLoginRoutes.post("/edgesonic/auth/login", async (c) => {
  const db = c.env.DB;

  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { username, password } = body;
  if (!username || !password) {
    return c.json({ ok: false, error: "Missing username or password" }, 400);
  }

  const user = await db
    .prepare("SELECT username, master_password AS password, level, enabled FROM users WHERE username = ?")
    .bind(username)
    .first<{ username: string; password: string; level: number; enabled: number }>();
  if (!user || !user.enabled) {
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }

  const hash = await sha256(password);
  if (hash !== user.password) {
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const userAgent = c.req.header("User-Agent") || "";

  // 090 — Session stored only in D1 `sessions` table (KV session: cache removed).
  await db
    .prepare(
      "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, username, sessionToken, userAgent, expiresAt, Math.floor(Date.now() / 1000))
    .run();

  return c.json({
    ok: true,
    username,
    level: user.level,
    sessionToken,
    expiresAt,
  });
});

webLoginRoutes.post("/edgesonic/auth/logout", async (c) => {
  const db = c.env.DB;

  let body: { sessionToken?: string; username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  // 090 — Logout only touches D1; KV session: cache removed.
  if (body.sessionToken) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(body.sessionToken).run();
  }

  return c.json({ ok: true });
});

export const edgesonicAuthRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// ─── Sessions ───────────────────────────────────────────────────────────────
edgesonicAuthRoutes.get("/auth/sessions/list", async (c) => {
  const db = c.env.DB;
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
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/sessions/revoke", async (c) => {
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  const db = c.env.DB;
  const user = c.get("user");
  const row = await db.prepare("SELECT token FROM sessions WHERE id = ? AND username = ?")
    .bind(body.id, user.username).first<{ token: string }>();
  if (!row) {
    return c.text(subsonicError(70, "Session not found"), 404, XML);
  }
  // 090 — D1 is the sole authority; no KV session: cache to delete.
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(body.id).run();
  return c.text(subsonicOK({}), 200, XML);
});

// ─── Subsonic Credentials ────────────────────────────────────────────────────
edgesonicAuthRoutes.get("/auth/credentials/list", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const rows = await db.prepare(
    "SELECT id, label, last_used, created_at, stream_proxy_strategy FROM subsonic_credentials WHERE username = ? ORDER BY created_at ASC"
  ).bind(user.username).all<{ id: string; label: string | null; last_used: number | null; created_at: number; stream_proxy_strategy: string | null }>();

  return c.text(
    subsonicOK({
      subsonicCredentials: {
        credential: rows.results.map((r) => ({
          _attributes: {
            id: r.id,
            label: r.label || "",
            lastUsed: r.last_used ? String(r.last_used) : "0",
            createdAt: String(r.created_at),
            streamProxyStrategy: r.stream_proxy_strategy || "always",
          },
        })),
      },
    }),
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/credentials/create", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  const count = await db.prepare(
    "SELECT COUNT(*) AS cnt FROM subsonic_credentials WHERE username = ?"
  ).bind(user.username).first<{ cnt: number }>();
  if (count && count.cnt >= 64) {
    return c.text(subsonicError(0, "Maximum 64 Subsonic credentials per user"), 400, XML);
  }

  const body = await c.req.json<{ password: string; label?: string; streamProxyStrategy?: string }>();
  if (!body.password) {
    return c.text(subsonicError(0, "Missing password"), 400, XML);
  }

  // 092 — validate optional stream_proxy_strategy. Default 'always'.
  const strategy = body.streamProxyStrategy || "always";
  if (!["always", "never", "r2_only", "webdav_only"].includes(strategy)) {
    return c.text(subsonicError(0, "Invalid streamProxyStrategy (always|never|r2_only|webdav_only)"), 400, XML);
  }

  const id = crypto.randomUUID().substring(0, 12);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO subsonic_credentials (id, username, password, label, stream_proxy_strategy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, user.username, body.password, body.label || "", strategy, now).run();

  return c.text(
    subsonicOK({
      credential: { _attributes: { id, label: body.label || "", streamProxyStrategy: strategy } },
    }),
    200, XML,
  );
});

// 082 — Rename an existing Subsonic credential's label (e.g. "Pixel" → "DSub
// on Pixel 9"). Doesn't touch the password or last_used; just lets the user
// keep their device registry tidy.
//   - body: { id, label }
//   - username pinned to the session user — UPDATE WHERE id=? AND username=?
//     ensures one user can never relabel another user's credential, and
//     skips the need for a separate "exists & owned" lookup.
//   - label must be a non-null string ≤200 chars; we allow empty to clear.
//   - meta.changes === 0 means no row matched → either bogus id or someone
//     else's credential. Both are surfaced as 404 (consistent with the
//     sessions/revoke handler above).
edgesonicAuthRoutes.post("/auth/credentials/update", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  let body: { id?: string; label?: string; streamProxyStrategy?: string };
  try {
    body = await c.req.json<{ id?: string; label?: string; streamProxyStrategy?: string }>();
  } catch {
    return c.text(subsonicError(0, "Invalid JSON body"), 400, XML);
  }

  if (!body.id) {
    return c.text(subsonicError(0, "Missing credential id"), 400, XML);
  }
  if (typeof body.label !== "string") {
    return c.text(subsonicError(0, "Missing label"), 400, XML);
  }
  if (body.label.length > 200) {
    return c.text(subsonicError(0, "Label too long (max 200 chars)"), 400, XML);
  }

  // 092 — optional stream_proxy_strategy update. When absent we leave it
  // unchanged (so the label-only rename path stays a single-column UPDATE).
  const strategy = body.streamProxyStrategy;
  if (strategy !== undefined && !["always", "never", "r2_only", "webdav_only"].includes(strategy)) {
    return c.text(subsonicError(0, "Invalid streamProxyStrategy (always|never|r2_only|webdav_only)"), 400, XML);
  }

  const result = strategy === undefined
    ? await db.prepare(
        "UPDATE subsonic_credentials SET label = ? WHERE id = ? AND username = ?",
      ).bind(body.label, body.id, user.username).run()
    : await db.prepare(
        "UPDATE subsonic_credentials SET label = ?, stream_proxy_strategy = ? WHERE id = ? AND username = ?",
      ).bind(body.label, strategy, body.id, user.username).run();

  if (!result.meta.changes) {
    return c.text(subsonicError(70, "Credential not found"), 404, XML);
  }

  return c.text(
    subsonicOK({
      credential: { _attributes: { id: body.id, label: body.label, streamProxyStrategy: strategy ?? undefined } },
    }),
    200, XML,
  );
});

edgesonicAuthRoutes.post("/auth/credentials/delete", permissionMiddleware("manage_credentials"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing credential id"), 400, XML);
  }
  await db.prepare(
    "DELETE FROM subsonic_credentials WHERE id = ? AND username = ?"
  ).bind(body.id, user.username).run();
  return c.text(subsonicOK({}), 200, XML);
});

// ─── Guest tokens ───────────────────────────────────────────────────────────
edgesonicAuthRoutes.post("/auth/guestToken", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ expiresIn?: number }>();
  const db = c.env.DB;
  const user = c.get("user");
  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + (body.expiresIn || 86400);

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
    200, XML,
  );
});

