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
import { createMiddleware } from "hono/factory";
import { md5 } from "./utils/md5";
import { getFeature, parseChain } from "./utils/features";
import type { User } from "./types/entities";

export type AuthMethod = "session" | "subsonic_cred" | "apikey" | "guest";

// ============================================================================
// Path Classification
// ============================================================================

const NO_AUTH_PATHS = new Set([
  "/rest/ping",
  "/rest/getLicense",
  "/rest/getOpenSubsonicExtensions",
  "/rest/loginWeb",
]);

const GUEST_ALLOWED_PATHS = new Set([
  "/rest/stream",
  "/rest/getCoverArt",
  "/rest/getArtists",
  "/rest/getArtist",
  "/rest/getAlbum",
  "/rest/getSong",
  "/rest/getIndexes",
  "/rest/getMusicFolders",
  "/rest/getGenres",
  "/rest/getSongsByGenre",
  "/rest/getAlbumList2",
  "/rest/search3",
]);

// Endpoints reserved for web-session credentials (authMethod === "session").
// Capability is bound to the credential type, not the User-Agent (DESIGN.md §3.1):
// subsonic_credentials / apiKey can stream & browse but never touch files or admin.
const SESSION_ONLY_PATHS = new Set([
  "/rest/getStorageSources",
  "/rest/addStorageSource",
  "/rest/updateStorageSource",
  "/rest/deleteStorageSource",
  "/rest/getUsers",
  "/rest/createUser",
  "/rest/updateUser",
  "/rest/deleteUser",
  "/rest/getUser",
  "/rest/getPermissions",
  "/rest/updatePermission",
  "/rest/upload",
  "/rest/download",
  "/rest/getCredentials",
  "/rest/createCredential",
  "/rest/deleteCredential",
  "/rest/getSessions",
  "/rest/revokeSession",
  "/rest/getFeatures",
  "/rest/updateFeature",
]);

// ============================================================================
// SHA-256 Hash (for master password verification)
// ============================================================================
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// Subsonic Credential Lookup
// ============================================================================
async function findSubsonicCredential(
  db: D1Database,
  kv: KVNamespace,
  username: string,
  token: string,
  salt: string,
): Promise<{ credential: string; kind: "subsonic_cred" | "session" } | null> {
  // 1. Check subsonic_credentials table
  const creds = await db
    .prepare("SELECT password FROM subsonic_credentials WHERE username = ?")
    .bind(username)
    .all<{ password: string }>();

  for (const cred of creds.results) {
    if (md5(cred.password + salt) === token) {
      // Update last_used
      await db
        .prepare("UPDATE subsonic_credentials SET last_used = ? WHERE username = ? AND password = ?")
        .bind(Math.floor(Date.now() / 1000), username, cred.password)
        .run();
      return { credential: cred.password, kind: "subsonic_cred" };
    }
  }

  // 2. Check active sessions (session token as Subsonic password)
  const sessions = await db
    .prepare("SELECT token FROM sessions WHERE username = ? AND expires_at > ?")
    .bind(username, Math.floor(Date.now() / 1000))
    .all<{ token: string }>();

  for (const sess of sessions.results) {
    if (md5(sess.token + salt) === token) {
      return { credential: sess.token, kind: "session" };
    }
  }

  // 3. Also try KV cache for sessions (faster lookup)
  const kvSessionToken = await kv.get(`session:${username}`);
  if (kvSessionToken && md5(kvSessionToken + salt) === token) {
    return { credential: kvSessionToken, kind: "session" };
  }

  return null;
}

// ============================================================================
// User Lookup (by username)
// ============================================================================
async function lookupUser(db: D1Database, username: string): Promise<User | null> {
  return db
    .prepare("SELECT username, master_password AS password, level, enabled FROM users WHERE username = ?")
    .bind(username)
    .first<User>();
}

// ============================================================================
// Web Login Handler
// ============================================================================
export const webLoginRoutes = new Hono<{ Bindings: Env }>();

webLoginRoutes.post("/rest/loginWeb", async (c) => {
  const db = c.env.DB;
  const kv = c.env.KV;

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

  const user = await lookupUser(db, username);
  if (!user || !user.enabled) {
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }

  // Verify master password (SHA-256)
  const hash = await sha256(password);
  if (hash !== user.password) {
    return c.json({ ok: false, error: "Invalid credentials" }, 401);
  }

  // Create session
  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
  const userAgent = c.req.header("User-Agent") || "";

  await db
    .prepare(
      "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(sessionId, username, sessionToken, userAgent, expiresAt, Math.floor(Date.now() / 1000))
    .run();

  // Cache session in KV for fast lookup
  await kv.put(`session:${username}`, sessionToken, { expirationTtl: 86400 });

  return c.json({
    ok: true,
    username,
    level: user.level,
    sessionToken,
    expiresAt,
  });
});

webLoginRoutes.post("/rest/logoutWeb", async (c) => {
  const db = c.env.DB;
  const kv = c.env.KV;

  let body: { sessionToken?: string; username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.sessionToken) {
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(body.sessionToken).run();
  }
  if (body.username) {
    await kv.delete(`session:${body.username}`);
  }

  return c.json({ ok: true });
});

// ============================================================================
// Main Auth Middleware (Subsonic API)
// ============================================================================
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: User; authMethod: AuthMethod };
}>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // --- Anti-loop proxy chain guard (DESIGN.md §3.2) ---
  // Another EdgeSonic proxying us appends its INSTANCE_ID to esChain.
  const chain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
  if (chain.length > 0) {
    const xmlHeaders = { "Content-Type": "application/xml; charset=UTF-8" };
    if (chain.includes(c.env.INSTANCE_ID)) {
      return c.text(subsonicError(50, "Proxy loop detected"), 403, xmlHeaders);
    }
    const maxDepth = parseInt(c.env.MAX_PROXY_DEPTH || "3", 10);
    if (chain.length > maxDepth) {
      return c.text(subsonicError(50, "Proxy chain too deep"), 403, xmlHeaders);
    }
    if (!(await getFeature(c.env, "allow_being_proxied"))) {
      return c.text(subsonicError(50, "This server does not accept proxied requests"), 403, xmlHeaders);
    }
  }

  if (NO_AUTH_PATHS.has(path)) {
    return next();
  }

  const q = c.req.query();
  const username = q.u;
  const token = q.t;
  const salt = q.s;
  const apiKey = q.apiKey;
  const guestToken = q.guestToken;
  const db = c.env.DB;
  const kv = c.env.KV;

  if (!username) {
    return c.text(subsonicError(40, "Missing username"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const user = await lookupUser(db, username);
  if (!user || !user.enabled) {
    return c.text(subsonicError(40, "Wrong username or password"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  // --- Authenticate (records which credential type succeeded) ---
  let authMethod: AuthMethod | null = null;

  if (apiKey) {
    // API Key authentication (via KV)
    const storedUser = await kv.get(`apikey:${apiKey}`);
    if (storedUser === username) {
      authMethod = "apikey";
    }
  } else if (token && salt) {
    // Subsonic token auth: subsonic_credentials or web session token
    const cred = await findSubsonicCredential(db, kv, username, token, salt);
    if (cred) {
      authMethod = cred.kind;
    }
  }

  if (!authMethod) {
    return c.text(subsonicError(40, "Wrong username or password"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  // --- Guest (Level 0) Access Control ---
  if (user.level === 0) {
    authMethod = "guest";
    if (guestToken) {
      const tokenData = await db
        .prepare("SELECT * FROM guest_tokens WHERE token = ? AND expires_at > ?")
        .bind(guestToken, Math.floor(Date.now() / 1000))
        .first();
      if (!tokenData) {
        return c.text(subsonicError(50, "Guest access denied or token expired"), 403, {
          "Content-Type": "application/xml; charset=UTF-8",
        });
      }
    } else if (GUEST_ALLOWED_PATHS.has(path)) {
      const guestPerm = await db
        .prepare("SELECT enabled FROM user_permissions WHERE level = 0 AND permission = 'browse'")
        .first<{ enabled: number }>();
      if (!guestPerm || !guestPerm.enabled) {
        return c.text(subsonicError(50, "Guest access is disabled"), 403, {
          "Content-Type": "application/xml; charset=UTF-8",
        });
      }
    } else {
      return c.text(subsonicError(50, "Guest access not permitted"), 403, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
  }

  // --- Session-Only Guard (credential-type gating, replaces UA sniffing) ---
  // File R/W and admin endpoints are reserved for web-session credentials:
  // a leaked subsonic_credential or apiKey can never escalate to file access.
  if (SESSION_ONLY_PATHS.has(path) && authMethod !== "session") {
    return c.text(subsonicError(50, "This endpoint requires a web session credential"), 403, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  c.set("user", user);
  c.set("authMethod", authMethod);
  return next();
});

// ============================================================================
// Permission Middleware
// ============================================================================
export const permissionMiddleware = (requiredPermission: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User };
  }>(async (c, next) => {
    const user = c.get("user");
    const db = c.env.DB;

    const perm = await db
      .prepare("SELECT enabled, max_rph FROM user_permissions WHERE level = ? AND permission = ?")
      .bind(user.level, requiredPermission)
      .first<{ enabled: number; max_rph: number }>();

    if (!perm || !perm.enabled) {
      return c.text(subsonicError(50, "Not authorized"), 403, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }

    if (perm.max_rph > 0) {
      const kv = c.env.KV;
      const rphKey = `rph:${user.username}:${requiredPermission}`;
      const count = parseInt((await kv.get(rphKey)) || "0", 10);
      if (count >= perm.max_rph) {
        return c.text(subsonicError(50, "Rate limit exceeded"), 429, {
          "Content-Type": "application/xml; charset=UTF-8",
        });
      }
      await kv.put(rphKey, String(count + 1), { expirationTtl: 3600 });
    }

    return next();
  });

// ============================================================================
// Minimum Level Guard
// ============================================================================
export function minLevel(level: number) {
  return createMiddleware<{
    Bindings: Env;
    Variables: { user: User };
  }>(async (c, next) => {
    const user = c.get("user");
    if (user.level < level) {
      return c.text(subsonicError(50, "Insufficient permissions"), 403, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
    return next();
  });
}

// ============================================================================
// Subsonic XML Error Helper
// ============================================================================
export function subsonicError(code: number, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1">
  <error code="${code}" message="${escapeXml(message)}"/>
</subsonic-response>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
