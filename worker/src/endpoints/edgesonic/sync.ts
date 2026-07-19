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

// Per-user peer-sync config (any signed-in non-guest). Stored in user_settings
// alongside the Last.fm key. The peer password is write-only over the wire: GET
// returns only whether it is set, never the value.
import { Hono } from "hono";
import type { User } from "../../types/entities";

export const syncRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const KEYS = [
  "sync_peer_url",
  "sync_peer_username",
  "sync_peer_password",
  "sync_peer_enabled",
  "sync_peer_playlist_scope",
  "sync_peer_playlist_names",
] as const;

type PlaylistScope = "own" | "own_public" | "custom";

syncRoutes.get("/sync/config", async (c) => {
  const user = c.get("user");
  if (user.level < 1) return c.json({ ok: false, error: "Guests cannot use sync" }, 403);
  const rows = await c.env.DB
    .prepare(`SELECT key, value FROM user_settings WHERE username = ? AND key IN (${KEYS.map(() => "?").join(",")})`)
    .bind(user.username, ...KEYS)
    .all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of rows.results) m[r.key] = r.value;
  let playlistNames: string[] = [];
  if (m.sync_peer_playlist_names) {
    try { const a = JSON.parse(m.sync_peer_playlist_names); if (Array.isArray(a)) playlistNames = a.map((x) => String(x)); }
    catch { /* corrupt → empty */ }
  }
  const scope: PlaylistScope =
    m.sync_peer_playlist_scope === "own_public" || m.sync_peer_playlist_scope === "custom"
      ? (m.sync_peer_playlist_scope as PlaylistScope)
      : "own";
  return c.json({
    ok: true,
    enabled: m.sync_peer_enabled === "1",
    url: m.sync_peer_url || "",
    username: m.sync_peer_username || "",
    passwordSet: !!(m.sync_peer_password && m.sync_peer_password.length),
    playlistScope: scope,
    playlistNames,
  });
});

syncRoutes.post("/sync/config", async (c) => {
  const user = c.get("user");
  if (user.level < 1) return c.json({ ok: false, error: "Guests cannot use sync" }, 403);
  const body = await c.req.json<{
    enabled?: boolean;
    url?: string;
    username?: string;
    password?: string;
    playlistScope?: PlaylistScope;
    playlistNames?: string[];
  }>().catch(() => null);
  if (!body) return c.json({ ok: false, error: "Invalid JSON body" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const set = (key: string, value: string) => c.env.DB
    .prepare("INSERT INTO user_settings (username, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(user.username, key, value, now).run();

  if (typeof body.url === "string") {
    const url = body.url.trim().replace(/\/+$/, "").replace(/\/rest$/, "");
    if (url && !/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "URL must start with http:// or https://" }, 400);
    await set("sync_peer_url", url);
  }
  if (typeof body.username === "string") await set("sync_peer_username", body.username.trim());
  // Password only updated when a non-empty value is supplied, so toggling
  // `enabled` never wipes it. Empty string explicitly clears it.
  if (typeof body.password === "string" && body.password.length > 0) await set("sync_peer_password", body.password);
  else if (body.password === "") await set("sync_peer_password", "");

  if (body.playlistScope === "own" || body.playlistScope === "own_public" || body.playlistScope === "custom") {
    await set("sync_peer_playlist_scope", body.playlistScope);
  }
  if (Array.isArray(body.playlistNames)) {
    // Sanitise: unique non-empty strings, trimmed, max 200 entries.
    const names = Array.from(
      new Set(body.playlistNames.map((n) => String(n).trim()).filter((n) => n.length > 0)),
    ).slice(0, 200);
    await set("sync_peer_playlist_names", JSON.stringify(names));
  }

  if (typeof body.enabled === "boolean") {
    if (body.enabled) {
      // Refuse to enable an incomplete config — a half-set peer just errors.
      const rows = await c.env.DB
        .prepare(`SELECT key, value FROM user_settings WHERE username = ? AND key IN (${KEYS.map(() => "?").join(",")})`)
        .bind(user.username, ...KEYS)
        .all<{ key: string; value: string }>();
      const m: Record<string, string> = {};
      for (const r of rows.results) m[r.key] = r.value;
      if (!m.sync_peer_url || !m.sync_peer_username || !m.sync_peer_password) {
        return c.json({ ok: false, error: "Set URL, username and password before enabling" }, 400);
      }
    }
    await set("sync_peer_enabled", body.enabled ? "1" : "0");
  }

  return c.json({ ok: true });
});
