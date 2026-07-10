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
import { hasPermission } from "./utils/permissions";
import { SERVER_TYPE, SERVER_VERSION } from "./utils/xml";
import type { User } from "./types/entities";

export type AuthMethod = "session" | "subsonic_cred" | "apikey" | "guest";

// ============================================================================
// Path Classification
// ============================================================================

//   /rest/*      Subsonic protocol  → existing token+salt / apikey / guestToken
//   /tag/*       Tag management     → web session ONLY
//   /storage/*   Storage management → web session ONLY
//   /edgesonic/* EdgeSonic private  → web session ONLY (login path skips auth)
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
// Subsonic Credential Lookup
// ============================================================================
// the sole authority; the KV "faster lookup" was a micro-optimisation that
// burned KV quota. Sessions still live in D1 exclusively.
async function findSubsonicCredential(
  db: D1Database,
  username: string,
  token: string,
  salt: string,
): Promise<{ credential: string; kind: "subsonic_cred" | "session"; streamProxyStrategy: string } | null> {
  // 1. Check subsonic_credentials table
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

  // 2. Check active sessions (session token as Subsonic password)
  const sessions = await db
    .prepare("SELECT token FROM sessions WHERE username = ? AND expires_at > ?")
    .bind(username, Math.floor(Date.now() / 1000))
    .all<{ token: string }>();

  for (const sess of sessions.results) {
    if (md5(sess.token + salt) === token) {
      // of hard-dying 24h after login (which users perceived as "the deploy
      // logged me out" — the 081 update banner made them reload right onto
      // the expired session). Bump only when under 20h remain so a busy tab
      // costs at most one D1 write every ~4h.
      await renewSessionIfNeeded(db, sess.token);
      return { credential: sess.token, kind: "session", streamProxyStrategy: "always" };
    }
  }

  return null;
}

const SESSION_TTL_SEC = 86400;
const SESSION_RENEW_THRESHOLD_SEC = 72000; // renew when < 20h left

async function renewSessionIfNeeded(db: D1Database, token: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at < ?")
    .bind(now + SESSION_TTL_SEC, token, now + SESSION_RENEW_THRESHOLD_SEC)
    .run();
}

// clients (and "force plain-text auth" toggles) never send t/s; before 105
// those requests fell through to "Wrong username or password". Order mirrors
// findSubsonicCredential: subsonic_credentials first, then session tokens.
async function findSubsonicCredentialByPassword(
  db: D1Database,
  username: string,
  rawPassword: string,
): Promise<{ credential: string; kind: "subsonic_cred" | "session"; streamProxyStrategy: string } | null> {
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

  const sessions = await db
    .prepare("SELECT token FROM sessions WHERE username = ? AND expires_at > ?")
    .bind(username, Math.floor(Date.now() / 1000))
    .all<{ token: string }>();
  for (const sess of sessions.results) {
    if (sess.token === plain) {
      await renewSessionIfNeeded(db, sess.token);
      return { credential: sess.token, kind: "session", streamProxyStrategy: "always" };
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
  Variables: { user: User; authMethod: AuthMethod; streamProxyStrategy?: string };
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

  if (!username) {
    return authFail(40, "Missing username", 401);
  }

  const user = await lookupUser(db, username);
  if (!user || !user.enabled) {
    return authFail(40, "Wrong username or password", 401);
  }

  // --- Authenticate (records which credential type succeeded) ---
  let authMethod: AuthMethod | null = null;

  if (apiKey) {
    const row = await db
      .prepare("SELECT username FROM api_keys WHERE api_key = ?")
      .bind(apiKey)
      .first<{ username: string }>();
    if (row?.username === username) {
      authMethod = "apikey";
    }
  } else if (token && salt) {
    // Subsonic token auth: subsonic_credentials or web session token
    const cred = await findSubsonicCredential(db, username, token, salt);
    if (cred) {
      authMethod = cred.kind;
      c.set("streamProxyStrategy", cred.streamProxyStrategy);
    }
  } else if (q.p) {
    const cred = await findSubsonicCredentialByPassword(db, username, q.p);
    if (cred) {
      authMethod = cred.kind;
      c.set("streamProxyStrategy", cred.streamProxyStrategy);
    }
  }

  if (apiKey && authMethod === "apikey") {
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

  // --- Session-Only Guard (credential-type gating, replaces UA sniffing) ---
  // The /tag /storage /edgesonic buckets are management-only and uniformly
  // demand a web session credential. Inside /rest/* a handful of management-
  // shaped endpoints (changePassword, share/podcast/radio CUD, download) still
  // need the same protection — REST_SESSION_ONLY_PATHS lists those.
  const needsSession = isMgmt || REST_SESSION_ONLY_PATHS.has(path);
  if (needsSession && authMethod !== "session") {
    return authFail(50, "This endpoint requires a web session credential", 403);
  }

  c.set("user", user);
  c.set("authMethod", authMethod);
  return next();
});

// ============================================================================
// Permission Middleware
// ============================================================================
// The per-permission RPH sliding-window rate limit that used to live
// here was removed (Rosmontis: authorisation should just be "does this level
// have this permission", no per-permission hourly throttling). The enabled check
// now goes through the shared hasPermission() helper (utils/permissions.ts)
// so both this middleware and in-handler degradation checks (shares.ts /
// playlists.ts / now_playing.ts / users.ts) read from the same source —
// PERMISSIONS_OVERRIDE env var first, D1 user_permissions as fallback.
export const permissionMiddleware = (requiredPermission: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User; authMethod: AuthMethod; streamProxyStrategy?: string };
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
