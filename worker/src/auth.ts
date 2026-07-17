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
import { getServerRelayPolicy, parseChain } from "./utils/features";
import { hasPermission } from "./utils/permissions";
import { SERVER_TYPE, SERVER_VERSION } from "./utils/xml";
import type { User } from "./types/entities";

export type AuthMethod = "session" | "subsonic_cred" | "apikey" | "guest";

export const SESSION_COOKIE = "edgesonic_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const SESSION_RENEW_THRESHOLD_SEC = 3 * 24 * 60 * 60; // renew when < 3 days left

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

// Shared with the login route so both login and the authMiddleware emit
// identical cookie attributes. Workers terminate TLS in production; the
// Secure flag is appended by the caller when the request arrived over HTTPS.
export function buildSessionCookieHeader(token: string, maxAgeSec: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

// Cookie-based session lookup used by the authMiddleware when the request
// arrives without Subsonic signed params (the SPA's same-origin fetches
// after the httpOnly-cookie login; see /edgesonic/auth/login). Returns the
// same shape as findSubsonicCredentialByPassword so the caller can drop the
// result straight into the authMethod === "session" path.
async function findSessionByCookie(
  db: D1Database,
  cookieToken: string,
): Promise<{ credential: string; kind: "session"; streamProxyStrategy: string } | null> {
  const row = await db
    .prepare("SELECT token FROM sessions WHERE token = ? AND expires_at > ?")
    .bind(cookieToken, Math.floor(Date.now() / 1000))
    .first<{ token: string }>();
  if (!row) return null;
  await renewSessionIfNeeded(db, row.token);
  return { credential: row.token, kind: "session", streamProxyStrategy: "always" };
}

// ============================================================================
// Path Classification
// ============================================================================

//   /rest/*     Subsonic protocol → existing token+salt / apikey / guestToken
//   /tag/*       Tag management   → web session ONLY
//   /storage/* Storage management → web session ONLY
//  /edgesonic/* EdgeSonic private → web session ONLY (login path skips auth)
// The non-rest buckets uniformly require authMethod === "session" so a leaked
// subsonic_credentials / apiKey cannot reach management surfaces.

const NO_AUTH_PATHS = new Set([
  // clients can use /rest/ping to verify credentials. Most Subsonic servers
  // (including the reference music-tag-web instance) require auth on ping;
  // clients that ping without credentials to test connectivity will get a
  // 401 error code, which is the expected behaviour. Only the OpenSubsonic
  // extension probe stays public (clients check it before authenticating).
  "/rest/getOpenSubsonicExtensions",
  "/rest/getOpenSubsonicExtensions.view",
  // for every other request, so it has to live outside the auth filter.
  "/edgesonic/auth/login",
  "/edgesonic/auth/logout",
  // build version and isolate start time (non-sensitive); the SPA polls it
  // every 5 minutes including AFTER the session has expired so the "refresh
  // me" banner still appears on stale tabs.
  "/edgesonic/version",
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
  // clients to call. External fetch fallback only writes to D1, never to files.
  "/rest/getLyrics",
  "/rest/getLyricsBySongId",
]);

// Inside /rest/* there are still a handful of endpoints that must reject
// non-session credentials (changePassword, share/podcast/radio CUD, download).
// Everything else management-shaped now lives outside /rest/* so the prefix
// check handles it implicitly.
const REST_SESSION_ONLY_PATHS = new Set([
  "/rest/changePassword",
  "/rest/changePassword.view",
  // download (R2/WebDAV-backed binary, large bandwidth potential)
  "/rest/download",
  "/rest/createShare",
  "/rest/createShare.view",
  "/rest/updateShare",
  "/rest/updateShare.view",
  "/rest/deleteShare",
  "/rest/deleteShare.view",
  "/rest/createInternetRadioStation",
  "/rest/createInternetRadioStation.view",
  "/rest/updateInternetRadioStation",
  "/rest/updateInternetRadioStation.view",
  "/rest/deleteInternetRadioStation",
  "/rest/deleteInternetRadioStation.view",
  "/rest/createPodcastChannel",
  "/rest/createPodcastChannel.view",
  "/rest/deletePodcastChannel",
  "/rest/deletePodcastChannel.view",
  "/rest/deletePodcastEpisode",
  "/rest/deletePodcastEpisode.view",
  "/rest/refreshPodcasts",
  "/rest/refreshPodcasts.view",
  "/rest/downloadPodcastEpisode",
  "/rest/downloadPodcastEpisode.view",
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
// Subsonic Credential Lookup (token/salt auth)
// ============================================================================
// Only checks subsonic_credentials. Session tokens cannot be used as password
// or salt in any form. Sessions must use HTTP-only cookie authentication.
async function findSubsonicCredential(
  db: D1Database,
  username: string,
  token: string,
  salt: string,
): Promise<{ credential: string; kind: "subsonic_cred"; streamProxyStrategy: string } | null> {
  const creds = await db
    .prepare("SELECT password, stream_proxy_strategy FROM subsonic_credentials WHERE username = ?")
    .bind(username)
    .all<{ password: string; stream_proxy_strategy: string | null }>();

  for (const cred of creds.results) {
    if (md5(cred.password + salt) === token) {
      // Update last_used
      await db
        .prepare("UPDATE subsonic_credentials SET last_used = ? WHERE username = ? AND password = ?")
        .bind(Math.floor(Date.now() / 1000), username, cred.password)
        .run();
      const strat = cred.stream_proxy_strategy;
      const strategy = (strat === "always" || strat === "never" || strat === "r2_only" || strat === "webdav_only")
        ? strat
        : "always";
      return { credential: cred.password, kind: "subsonic_cred", streamProxyStrategy: strategy };
    }
  }

  return null;
}

async function renewSessionIfNeeded(db: D1Database, token: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at < ?")
    .bind(now + SESSION_TTL_SEC, token, now + SESSION_RENEW_THRESHOLD_SEC)
    .run();
}

// Only check subsonic_credentials table. Session-based authentication must use
// the HTTP-only session cookie, not Subsonic password parameters.
async function findSubsonicCredentialByPassword(
  db: D1Database,
  username: string,
  rawPassword: string,
): Promise<{ credential: string; kind: "subsonic_cred"; streamProxyStrategy: string } | null> {
  let plain = rawPassword;
  if (plain.startsWith("enc:")) {
    const hex = plain.substring(4);
    if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      // Subsonic hex-encodes the UTF-8 bytes of the password.
      plain = new TextDecoder().decode(bytes);
    }
  }

  const creds = await db
    .prepare("SELECT password, stream_proxy_strategy FROM subsonic_credentials WHERE username = ?")
    .bind(username)
    .all<{ password: string; stream_proxy_strategy: string | null }>();
  for (const cred of creds.results) {
    if (cred.password === plain) {
      await db
        .prepare("UPDATE subsonic_credentials SET last_used = ? WHERE username = ? AND password = ?")
        .bind(Math.floor(Date.now() / 1000), username, cred.password)
        .run();
      const strat = cred.stream_proxy_strategy;
      const strategy = (strat === "always" || strat === "never" || strat === "r2_only" || strat === "webdav_only")
        ? strat
        : "always";
      return { credential: cred.password, kind: "subsonic_cred", streamProxyStrategy: strategy };
    }
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

// /edgesonic/auth/login path lives next to the rest of the auth-management
// endpoints. The middleware below still has to skip the new path.

// ============================================================================
// Main Auth Middleware (Subsonic API)
// ============================================================================
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: User; authMethod: AuthMethod; authSource?: "cookie" | "query"; streamProxyStrategy?: string };
}>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // client; returning a Subsonic XML error body there breaks the SPA's
  // JSON.parse with "Unexpected token '<'". Format the error per request
  // path: XML for /rest/*, JSON for the management buckets. Mirrors the same
  // policy already used by permissionMiddleware below.
  const isMgmt = path.startsWith("/edgesonic/") || path.startsWith("/tag/") || path.startsWith("/storage/");
  // BEFORE this auth middleware in index.ts) converts to JSON when the
  // client sends f=json, keeping a single XML→JSON conversion point.
  const authFail = (code: number, message: string, status: 401 | 403) =>
    isMgmt
      ? c.json({ ok: false, error: message }, status)
      : c.text(subsonicError(code, message), status, {
          "Content-Type": "application/xml; charset=UTF-8",
        });

  // --- Anti-loop proxy chain guard (DESIGN.md §3.2) ---
  // Another EdgeSonic proxying us appends its INSTANCE_ID to esChain. The
  // chain guard only ever fires on /rest/* (proxied Subsonic calls), so we
  // keep the XML shape there; a management path would never carry esChain.
  // 178 (OpenSubsonic #254): the standard X-OpenSubsonic-Path header carries the
  // same comma-separated UUID chain as our proprietary esChain / X-EdgeSonic-Chain
  // (both use INSTANCE_ID as the server_uuid), so we accept any of the three.
  const chain = parseChain(
    c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain") || c.req.header("X-OpenSubsonic-Path"),
  );
  if (chain.length > 0) {
    const xmlHeaders = { "Content-Type": "application/xml; charset=UTF-8" };
    if (chain.includes(c.env.INSTANCE_ID)) {
      // Our own server_uuid already in the path → routing loop; abort per #254.
      return c.text(subsonicError(50, "Loop detected"), 403, xmlHeaders);
    }
    const maxDepth = parseInt(c.env.MAX_PROXY_DEPTH || "3", 10);
    if (chain.length > maxDepth) {
      return c.text(subsonicError(50, "Proxy chain too deep"), 403, xmlHeaders);
    }
    // Honour the declarative relay policy: a `deny` server refuses S2S relay.
    // Default derives from allow_being_proxied, so existing deployments are
    // unchanged (proxied-off ⇒ deny ⇒ rejected here).
    if ((await getServerRelayPolicy(c.env)) === "deny") {
      return c.text(subsonicError(50, "S2S relay denied (server_relay_policy=deny)"), 403, xmlHeaders);
    }
  }

  if (NO_AUTH_PATHS.has(path)) {
    return next();
  }

  const q = c.req.query();
  let username = q.u;
  const token = q.t;
  const salt = q.s;
  const apiKey = q.apiKey;
  const guestToken = q.guestToken;
  const db = c.env.DB;

  // apiKeyAuthentication (OpenSubsonic extension): the key IS the
  // credential — api_keys.api_key is the D1 primary key, so it already
  // identifies exactly one account. Per spec a client using this extension
  // may omit `u` entirely; look the row up before the "Missing username"
  // check so that path works. A caller who sends `u` alongside `apiKey`
  // still gets cross-checked below (can't ride someone else's key under a
  // different claimed username).
  let apiKeyRow: { username: string } | null = null;
  if (apiKey) {
    apiKeyRow = await db
      .prepare("SELECT username FROM api_keys WHERE api_key = ?")
      .bind(apiKey)
      .first<{ username: string }>();
    if (apiKeyRow && !username) username = apiKeyRow.username;
  }

  // HttpOnly-cookie SPA session: the cookie carries the session token
  // after /edgesonic/auth/login. SPA fetches arrive either with no `u`
  // (preferred) or with `u` matching the cookie's owner (legacy). Third-party
  // Subsonic clients never carry our cookie, so this branch only costs a
  // D1 round-trip for requests that actually came from the SPA — and it's
  // skipped entirely when an apiKey path is in play.
  const cookieToken = parseSessionCookie(c.req.header("Cookie") || "");
  let cookieSession: { credential: string; kind: "session"; streamProxyStrategy: string } | null = null;
  let cookieUsername: string | null = null;
  if (cookieToken && !apiKey) {
    cookieSession = await findSessionByCookie(db, cookieToken);
    if (cookieSession) {
      const sessUser = await db
        .prepare("SELECT username FROM sessions WHERE token = ?")
        .bind(cookieToken)
        .first<{ username: string }>();
      if (sessUser) cookieUsername = sessUser.username;
      // Only fill username from the cookie when the request didn't claim
      // one already; the cross-user mismatch case is rejected below in the
      // auth-method chain (cookieSession && cookieUsername !== username
      // falls through to auth-fail).
      if (!username && cookieUsername) username = cookieUsername;
    }
  }

  if (!username) {
    return authFail(40, "Missing username", 401);
  }

  const user = await lookupUser(db, username);
  if (!user || !user.enabled) {
    return authFail(40, "Wrong username or password", 401);
  }

  // --- Authenticate (records which credential type succeeded) ---
  let authMethod: AuthMethod | null = null;
  let authSource: "cookie" | "query" | null = null;

  if (apiKey) {
    if (apiKeyRow?.username === username) {
      authMethod = "apikey";
      authSource = "query";
    }
  } else if (token && salt) {
    // Subsonic token auth: subsonic_credentials or web session token
    const cred = await findSubsonicCredential(db, username, token, salt);
    if (cred) {
      authMethod = cred.kind;
      authSource = "query";
      c.set("streamProxyStrategy", cred.streamProxyStrategy);
    }
  } else if (q.p) {
    const cred = await findSubsonicCredentialByPassword(db, username, q.p);
    if (cred) {
      authMethod = cred.kind;
      authSource = "query";
      c.set("streamProxyStrategy", cred.streamProxyStrategy);
    }
  } else if (cookieSession && cookieUsername === username) {
    // SPA cookie path: cookie already validated above. The strict equality
    // also rejects a request that arrives with `u=attacker` and the
    // victim's cookie — if the claimed username doesn't match the row the
    // cookie belongs to, we fall through to auth-fail.
    authMethod = "session";
    authSource = "cookie";
    c.set("streamProxyStrategy", cookieSession.streamProxyStrategy);
  }

  if (apiKey && authMethod === "apikey") {
    authSource = "query";
    c.set("streamProxyStrategy", "always");
  }

  if (!authMethod) {
    console.log(`[auth-fail] path=${path} user=${username} hasApiKey=${!!apiKey} hasToken=${!!(token&&salt)} hasP=${!!q.p} ua=${c.req.header("User-Agent")?.slice(0,60)}`);
    return authFail(40, "Wrong username or password", 401);
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
        return authFail(50, "Guest access denied or token expired", 403);
      }
    } else if (GUEST_ALLOWED_PATHS.has(path)) {
      const guestPerm = await db
        .prepare("SELECT enabled FROM user_permissions WHERE level = 0 AND permission = 'browse'")
        .first<{ enabled: number }>();
      if (!guestPerm || !guestPerm.enabled) {
        return authFail(50, "Guest access is disabled", 403);
      }
    } else {
      return authFail(50, "Guest access not permitted", 403);
    }
  }

  // --- Credential-source guard ---
  // Built-in management APIs (/tag /storage /edgesonic) are browser-only and
  // require the HttpOnly cookie session. /rest/* remains protocol-compatible:
  // third-party clients can keep using token+salt / apiKey / plain password,
  // while same-origin browser requests may also authenticate by cookie.
  if (isMgmt && (authMethod !== "session" || authSource !== "cookie")) {
    return authFail(50, "This endpoint requires a browser cookie session", 403);
  }

  // Inside /rest/* a handful of management-shaped endpoints (changePassword,
  // share/podcast/radio CUD, download) still need a session credential, but it
  // may be either the browser cookie or the legacy web-session token+salt path
  // for REST compatibility.
  if (REST_SESSION_ONLY_PATHS.has(path) && authMethod !== "session") {
    return authFail(50, "This endpoint requires a web session credential", 403);
  }

  c.set("user", user);
  c.set("authMethod", authMethod);
  if (authSource) c.set("authSource", authSource);

  // Sliding cookie renewal: every successful cookie-session request refreshes
  // the browser cookie's Max-Age so it stays alive as long as the user is
  // active, mirroring the server-side renewSessionIfNeeded. Without this the
  // cookie lapses at its fixed 7-day Max-Age even though the DB session was
  // renewed, and the next request after that arrives without a cookie → 401
  // → the SPA logs out. A post-deploy reload surfacing as "lost login" was
  // the symptom that exposed the gap.
  if (authMethod === "session" && authSource === "cookie" && cookieToken) {
    const isHttps = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", buildSessionCookieHeader(cookieToken, SESSION_TTL_SEC) + (isHttps ? "; Secure" : ""), { append: true });
  }
  return next();
});

// ============================================================================
// Permission Middleware
// ============================================================================
// The per-permission RPH sliding-window rate limit that used to live
// here was removed (: authorisation should just be "does this level
// have this permission", no per-permission hourly throttling). The enabled check
// now goes through the shared hasPermission() helper (utils/permissions.ts)
// so both this middleware and in-handler degradation checks (shares.ts /
// playlists.ts / now_playing.ts / users.ts) read from the same source
// PERMISSIONS_OVERRIDE env var first, D1 user_permissions as fallback.
export const permissionMiddleware = (requiredPermission: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User; authMethod: AuthMethod; authSource?: "cookie" | "query"; streamProxyStrategy?: string };
  }>(async (c, next) => {
    const user = c.get("user");
    const enabled = await hasPermission(c.env, user, requiredPermission);

    // Management routes (/edgesonic/, /tag/, /storage/) consume JSON; Subsonic
    // /rest/* routes expect XML. Use the request path to pick the right format.
    const reqPath = c.req.path;
    const isMgmt = reqPath.startsWith("/edgesonic/") || reqPath.startsWith("/tag/") || reqPath.startsWith("/storage/");

    if (!enabled) {
      if (isMgmt) return c.json({ ok: false, error: "Not authorized" }, 403);
      return c.text(subsonicError(50, "Not authorized"), 403, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }

    return next();
  });

// ============================================================================
// ----------------------------------------------------------------------------
// The function existed but was never imported anywhere; its presence merely
// advertised the wrong pattern. EdgeSonic's security model is "authorisation
// lives on permission rows in user_permissions, NOT on the level integer".
// Use `permissionMiddleware("<perm>")` for request guards or `hasPermission`
// (see utils/permissions.ts) for in-handler degradation decisions. If a new
// capability needs a permission row, add it to the next migration file.
// ============================================================================

// ============================================================================
// Session-Only Middleware (禁止 Token + Cookie 混用)
// ============================================================================
export const sessionOnlyMiddleware = (permission?: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User; authMethod: AuthMethod; authSource?: "cookie" | "query"; streamProxyStrategy?: string };
  }>(async (c, next) => {
    const sessionCookie = parseSessionCookie(c.req.header("Cookie") || "");
    const subsonicU = c.req.query("u");
    const subsonicToken = c.req.header("X-Subsonic-Token");

    // 禁止混用：token 和 session 同时出现
    if ((subsonicU || subsonicToken) && sessionCookie) {
      return c.json({ error: "Cannot mix session and token authentication" }, 400);
    }

    // 必须有 session
    if (!sessionCookie) {
      return c.json({ error: "This endpoint requires session authentication" }, 401);
    }

    return next();
  });

// ============================================================================
// Token-Only Middleware (禁止 Session + Token 混用)
// ============================================================================
export const tokenOnlyMiddleware = (permission?: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User; authMethod: AuthMethod; authSource?: "cookie" | "query"; streamProxyStrategy?: string };
  }>(async (c, next) => {
    const sessionCookie = parseSessionCookie(c.req.header("Cookie") || "");
    const subsonicU = c.req.query("u");
    const subsonicToken = c.req.header("X-Subsonic-Token");
    const apiKey = c.req.query("apiKey");

    // 禁止混用：session 和 token 同时出现
    if ((subsonicU || subsonicToken || apiKey) && sessionCookie) {
      return c.json({ error: "Cannot mix session and token authentication" }, 400);
    }

    // 必须有 token（支持 Subsonic token 或 API key）
    if (!subsonicU && !subsonicToken && !apiKey) {
      return c.json({ error: "This endpoint requires token authentication" }, 401);
    }

    return next();
  });

// ============================================================================
// Subsonic XML Error Helper
// ============================================================================
export function subsonicError(code: number, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1" type="${SERVER_TYPE}" serverVersion="${SERVER_VERSION}" openSubsonic="true">
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
