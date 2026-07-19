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

// Per-user Last.fm surface. Sits under /edgesonic/* (web-session auth) —
// NOT under /rest/* (OpenSubsonic protocol). All routes read the caller's
// Last.fm username from user_settings and use the system-level api_key.
//
// Read-only by design: no session key (sk), no shared secret, no write
// surface. scrobble / love / unlove are intentionally NOT exposed.
//
//   GET  /edgesonic/lastfm/status       — am I configured?
//   POST /edgesonic/lastfm/username     — set / clear Last.fm username
//   GET  /edgesonic/lastfm/userInfo
//   GET  /edgesonic/lastfm/recentTracks?limit=...
//   GET  /edgesonic/lastfm/lovedTracks?limit=...
//   GET  /edgesonic/lastfm/topTracks?limit=...
//
// Per-user API key: each user may paste their own Last.fm API key
// (user_settings.lastfm_api_key); when set it takes precedence over the
// system-level key for the user.* read paths. Write paths (scrobble / love)
// are intentionally not supported (no session key, no shared secret).
import { Hono } from "hono";
import type { User } from "../../types/entities";
import {
  LastfmUnconfigured,
  LastfmFetchError,
  getUserInfo,
  getRecentTracks,
  getLovedTracks,
  getUserTopTracks,
} from "../../lib/lastfm";

export const lastfmRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

async function readUserSetting(db: D1Database, username: string, key: string): Promise<string> {
  const row = await db.prepare(
    "SELECT value FROM user_settings WHERE username = ? AND key = ?"
  ).bind(username, key).first<{ value: string }>();
  return row?.value || "";
}

async function writeUserSetting(
  db: D1Database,
  username: string,
  key: string,
  value: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (value) {
    await db.prepare(
      `INSERT INTO user_settings (username, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(username, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(username, key, value, now).run();
  } else {
    await db.prepare(
      "DELETE FROM user_settings WHERE username = ? AND key = ?"
    ).bind(username, key).run();
  }
}

// Wrap Last.fm exceptions into a consistent JSON shape. 409 when unconfigured
// (admin has not wired up the system key) so the UI can distinguish from
// 502 (upstream blip).
function mapError(e: unknown): Response {
  if (e instanceof LastfmUnconfigured) {
    return new Response(JSON.stringify({ ok: false, error: "lastfm_unconfigured" }), {
      status: 409, headers: { "Content-Type": "application/json" },
    });
  }
  if (e instanceof LastfmFetchError) {
    return new Response(JSON.stringify({ ok: false, error: e.message, upstreamCode: e.upstreamCode }), {
      status: 502, headers: { "Content-Type": "application/json" },
    });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 500, headers: { "Content-Type": "application/json" },
  });
}

lastfmRoutes.get("/lastfm/status", async (c) => {
  const user = c.get("user");
  const [username, apiKey] = await Promise.all([
    readUserSetting(c.env.DB, user.username, "lastfm_username"),
    readUserSetting(c.env.DB, user.username, "lastfm_api_key"),
  ]);
  return c.json({
    ok: true,
    username: username || "",
    usernameSet: !!username,
    apiKeySet: !!apiKey,
  });
});

// Set or clear the Last.fm username. Body: { username } — empty clears.
lastfmRoutes.post("/lastfm/username", async (c) => {
  const user = c.get("user");
  let body: { username?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  const value = (body.username || "").trim();
  await writeUserSetting(c.env.DB, user.username, "lastfm_username", value);
  return c.json({ ok: true, username: value, usernameSet: !!value });
});

// Set or clear the per-user Last.fm API key. Body: { apiKey } — empty clears.
// When set, this key takes precedence over the system-level key for the
// user.* read paths. The key itself is write-only over the wire: GET
// /lastfm/status returns only whether it is set, never the value.
lastfmRoutes.post("/lastfm/apiKey", async (c) => {
  const user = c.get("user");
  let body: { apiKey?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  const value = (body.apiKey || "").trim();
  await writeUserSetting(c.env.DB, user.username, "lastfm_api_key", value);
  return c.json({ ok: true, apiKeySet: !!value });
});

async function requireLastfmUsername(c: import("hono").Context): Promise<string | Response> {
  const user = c.get("user") as User;
  const username = await readUserSetting(c.env.DB, user.username, "lastfm_username");
  if (!username) {
    return c.json({ ok: false, error: "lastfm_username not set" }, 409);
  }
  return username;
}

lastfmRoutes.get("/lastfm/userInfo", async (c) => {
  const usernameOrResp = await requireLastfmUsername(c);
  if (usernameOrResp instanceof Response) return usernameOrResp;
  const edgesonicUser = (c.get("user") as User).username;
  try {
    const info = await getUserInfo(c.env, usernameOrResp, edgesonicUser);
    return c.json({ ok: true, info });
  } catch (e) { return mapError(e); }
});

lastfmRoutes.get("/lastfm/recentTracks", async (c) => {
  const usernameOrResp = await requireLastfmUsername(c);
  if (usernameOrResp instanceof Response) return usernameOrResp;
  const edgesonicUser = (c.get("user") as User).username;
  const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200));
  try {
    const tracks = await getRecentTracks(c.env, usernameOrResp, limit, edgesonicUser);
    return c.json({ ok: true, tracks });
  } catch (e) { return mapError(e); }
});

lastfmRoutes.get("/lastfm/lovedTracks", async (c) => {
  const usernameOrResp = await requireLastfmUsername(c);
  if (usernameOrResp instanceof Response) return usernameOrResp;
  const edgesonicUser = (c.get("user") as User).username;
  const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200));
  try {
    const tracks = await getLovedTracks(c.env, usernameOrResp, limit, edgesonicUser);
    return c.json({ ok: true, tracks });
  } catch (e) { return mapError(e); }
});

lastfmRoutes.get("/lastfm/topTracks", async (c) => {
  const usernameOrResp = await requireLastfmUsername(c);
  if (usernameOrResp instanceof Response) return usernameOrResp;
  const edgesonicUser = (c.get("user") as User).username;
  const limit = Math.max(1, Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200));
  try {
    const tracks = await getUserTopTracks(c.env, usernameOrResp, limit, edgesonicUser);
    return c.json({ ok: true, tracks });
  } catch (e) { return mapError(e); }
});