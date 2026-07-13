// credentials, guest tokens. Login is the only route in this whole tree that
// runs *before* the global authMiddleware (it issues the session token used by
// every other endpoint in /tag /storage /edgesonic).
import { Hono } from "hono";
import { permissionMiddleware, subsonicError, sha256 } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { recoverCronIfStale } from "../../utils/cronRecovery";
import type { User } from "../../types/entities";

// only request that legitimately arrives without a session) and is exported
// separately so index.ts can mount it BEFORE the global auth filter at the
// /edgesonic/auth/login + /edgesonic/auth/logout paths.
export const webLoginRoutes = new Hono<{ Bindings: Env }>();

const SESSION_COOKIE = "edgesonic_session";
const SESSION_TTL_SEC = 86400;

// SameSite=Lax (not Strict) so external OAuth-style redirects and the
// hash-router's first navigation still carry the cookie; HttpOnly + Secure
// is what stops JS-side credential theft and MITM leaks over clear text.
// Path=/ so it covers /rest, /tag, /storage, /edgesonic uniformly.
function sessionCookieHeader(token: string, maxAgeSec: number): string {
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  // Workers always terminate TLS in production; Secure would block the
  // cookie over plain HTTP in `wrangler dev --local`, so we only flag it
  // when the request itself arrived over HTTPS.
  return flags.join("; ");
}

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
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC; // 24 hours
  const userAgent = c.req.header("User-Agent") || "";

  await db
    .prepare(
      "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, username, sessionToken, userAgent, expiresAt, Math.floor(Date.now() / 1000))
    .run();

  // Post-deploy cron auto-recovery. A `wrangler deploy` clears the Worker's
  // cron triggers; this restores them from the recorded state when the running
  // WORKER_VERSION differs from the build cron was last applied under. A super
  // admin (level 3) login is the trigger point. Gated on level 3 — NOT the
  // delegatable manage_cloudflare permission — because it touches the CF API
  // token, which only the super admin may. Runs detached so it never delays
  // the login response.
  if (user.level >= 3) {
    const recovery = recoverCronIfStale(c.env).catch(() => {});
    try {
      c.executionCtx.waitUntil(recovery);
    } catch {
      // No execution context (e.g. unit tests) — let it run detached.
      void recovery;
    }
  }

  // Plant an HttpOnly cookie alongside the JSON response so the SPA can
  // stop persisting the session token in localStorage; the browser now
  // carries it for every same-origin request (fetch, <audio>, <img>,
  // XHR). The JSON sessionToken is still returned for backwards
  // compatibility (clients that use it as a Subsonic plain password via
  // /rest/?u=&p=), but the SPA itself no longer reads it.
  const isHttps = new URL(c.req.url).protocol === "https:";
  const cookie = sessionCookieHeader(sessionToken, SESSION_TTL_SEC) + (isHttps ? "; Secure" : "");
  c.header("Set-Cookie", cookie);
  return c.json(
    {
      ok: true,
      username,
      level: user.level,
      sessionToken,
      expiresAt,
    },
    200,
  );
});

webLoginRoutes.post("/edgesonic/auth/logout", async (c) => {
  const db = c.env.DB;

  let body: { sessionToken?: string; username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.sessionToken) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(body.sessionToken).run();
  } else {
    // Cookie-only SPA sessions have no token in the request body; invalidate
    // whatever the cookie carries so a stolen browser session can't keep
    // serving after the user clicked "Sign out".
    const cookieToken = parseSessionCookie(c.req.header("Cookie") || "");
    if (cookieToken) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(cookieToken).run();
    }
  }

  // Always wipe the browser cookie too — covers both cookie-only and
  // signedParams-style SPA sessions.
  const isHttps = new URL(c.req.url).protocol === "https:";
  c.header("Set-Cookie", sessionCookieHeader("", 0) + (isHttps ? "; Secure" : ""));
  return c.json({ ok: true });
});

function parseSessionCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === SESSION_COOKIE && v) return v;
  }
  return null;
}

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

// on Pixel 9"). Doesn't touch the password or last_used; just lets the user
// keep their device registry tidy.
//  - body: { id, label }
//  - username pinned to the session user — UPDATE WHERE id=? AND username=?
//   ensures one user can never relabel another user's credential, and
//   skips the need for a separate "exists & owned" lookup.
//  - label must be a non-null string ≤200 chars; we allow empty to clear.
//  - meta.changes === 0 means no row matched → either bogus id or someone
//   else's credential. Both are surfaced as 404 (consistent with the
//   sessions/revoke handler above).
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

