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

//
// Regression test for the httpOnly-cookie session auth path added to
// authMiddleware (see worker/src/auth.ts findSessionByCookie). The SPA's
// post-cookie-login fetches arrive with no u/t/s in the query string — the
// `edgesonic_session` cookie carries the credential, and the middleware
// resolves the username from the sessions table.
//
// Coverage:
//  1. Cookie-only (no query auth) on /tag, /storage, /edgesonic → 200,
//     authMethod=session (the cookie alone is enough).
//  2. Cookie + matching `u` from query → 200 (SPA may still send `u` for
//     log compatibility — must not break).
//  3. Cookie + mismatched `u` (u=attacker in query, cookie=victim) → 401
//     (anti-spoof: can't ride someone else's cookie under a different
//     claimed username).
//  4. Expired cookie → 401.
//  5. /edgesonic/auth/login sets `Set-Cookie` with `HttpOnly` and
//     `SameSite=Lax` flags and the session token as value.
//  6. /edgesonic/auth/logout clears the cookie.
//
// Run: npx tsx test/internal/auth_cookie_session.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";
import { webLoginRoutes } from "../../worker/src/endpoints/edgesonic/auth";
import { sha256 } from "../../worker/src/auth";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boundArgs: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { boundArgs = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT, level INTEGER NOT NULL, enabled INTEGER DEFAULT 1
    );
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE subsonic_credentials (
      username TEXT NOT NULL, password TEXT NOT NULL, stream_proxy_strategy TEXT, last_used INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL,
      user_agent TEXT, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('alice', 'hash', 2, 1);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('bob', 'hash', 1, 1);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('anonymous', '', 0, 1);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('guest', '', 0, 1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (0, 'browse', 1);
  `);
  return sqlite;
}

function insertSession(sqlite: DatabaseSync, token: string, username: string, expiresAt: number) {
  sqlite.prepare(
    "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, ?, ?, '', ?, ?)",
  ).run(`sess-${token}`, username, token, expiresAt, Math.floor(Date.now() / 1000));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.route("/", webLoginRoutes);
  app.use("/rest/*", authMiddleware);
  app.use("/tag/*", authMiddleware);
  app.use("/storage/*", authMiddleware);
  app.use("/edgesonic/*", authMiddleware);
  const ok = (c: import("hono").Context) => c.json({ ok: true, authMethod: c.get("authMethod") });
  app.get("/rest/ping", ok);
  app.get("/tag/whoami", ok);
  app.get("/storage/whoami", ok);
  app.get("/edgesonic/whoami", ok);
  const env = { DB: makeD1(sqlite), INSTANCE_ID: "test" };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async get(path: string, qs: string, cookie?: string): Promise<any> {
      const headers: Record<string, string> = {};
      if (cookie) headers["Cookie"] = cookie;
      return app.fetch(new Request(`http://test${path}?${qs}`, { headers }), env as any);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async postLogin(body: unknown): Promise<any> {
      return app.fetch(
        new Request("http://test/edgesonic/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env as any,
      );
    },
    async getGuest(): Promise<any> {
      return app.fetch(new Request("http://test/edgesonic/auth/guest"), env as any);
    },
    async postGuest(): Promise<any> {
      return app.fetch(new Request("http://test/edgesonic/auth/guest", { method: "POST" }), env as any);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async postLogout(cookie?: string): Promise<any> {
      return app.fetch(
        new Request("http://test/edgesonic/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: JSON.stringify({}),
        }),
        env as any,
      );
    },
  };
}

async function main() {
  const now = Math.floor(Date.now() / 1000);

  console.log("Cookie-only (no query auth) on management prefixes → 200, authMethod=session:");
  {
    const sqlite = buildDb();
    const token = "cookie-token-alice";
    insertSession(sqlite, token, "alice", now + 86400);
    const { get } = makeApp(sqlite);
    for (const p of ["/tag/whoami", "/storage/whoami", "/edgesonic/whoami", "/rest/ping"]) {
      const r = await get(p, "", `edgesonic_session=${token}`);
      assert(r.status === 200, `${p} 200 (got ${r.status})`);
      if (r.status === 200) {
        const b = await r.json() as { authMethod?: string };
        assert(b.authMethod === "session", `${p} authMethod=session (got ${b.authMethod})`);
      }
    }
  }

  console.log("\nCookie + matching `u` query param → 200 (no spoof rejection):");
  {
    const sqlite = buildDb();
    const token = "cookie-alice-2";
    insertSession(sqlite, token, "alice", now + 86400);
    const { get } = makeApp(sqlite);
    const r = await get("/tag/whoami", "u=alice", `edgesonic_session=${token}`);
    assert(r.status === 200, `/tag/whoami 200 (got ${r.status})`);
  }

  console.log("\nCookie + mismatched `u` (u=bob, cookie=alice with both users real) → 401 (anti-spoof):");
  {
    const sqlite = buildDb();
    const token = "cookie-alice-3";
    insertSession(sqlite, token, "alice", now + 86400);
    const { get } = makeApp(sqlite);
    const r = await get("/edgesonic/whoami", "u=bob", `edgesonic_session=${token}`);
    assert(r.status === 401, `/edgesonic/whoami 401 (got ${r.status})`);
    // The cookie alone (no u) must still succeed for alice, so we know the
    // session itself is valid and the rejection came from the cross-check.
    const r2 = await get("/edgesonic/whoami", "", `edgesonic_session=${token}`);
    assert(r2.status === 200, `same cookie without u=spoof → 200 (got ${r2.status})`);
  }

  console.log("\nExpired cookie → 401:");
  {
    const sqlite = buildDb();
    const token = "cookie-expired";
    insertSession(sqlite, token, "alice", now - 3600);
    const { get } = makeApp(sqlite);
    const r = await get("/tag/whoami", "", `edgesonic_session=${token}`);
    assert(r.status === 401, `/tag/whoami 401 (got ${r.status})`);
  }

  console.log("\nlogin endpoint sets HttpOnly + SameSite=Lax cookie:");
  {
    const sqlite = buildDb();
    // sha256('pw') to match what login would compute; we just check the cookie shape.
    sqlite.prepare("UPDATE users SET master_password = ? WHERE username = 'alice'").run(await sha256("pw"));
    const { postLogin } = makeApp(sqlite);
    const r = await postLogin({ username: "alice", password: "pw" });
    assert(r.status === 200, `login 200 (got ${r.status})`);
    const sc = r.headers.get("Set-Cookie") || "";
    assert(sc.startsWith("edgesonic_session="), `Set-Cookie starts with edgesonic_session= (got ${sc.slice(0, 40)}...)`);
    assert(sc.includes("HttpOnly"), `HttpOnly flag present (got ${sc})`);
    assert(sc.includes("SameSite=Lax"), `SameSite=Lax flag present (got ${sc})`);
    assert(sc.includes("Max-Age=604800"), `Max-Age=604800 (7d) present (got ${sc})`);
    assert(sc.includes("Path=/"), `Path=/ present (got ${sc})`);
  }

  console.log("\nguest endpoint only enables guest login when browsing is allowed:");
  {
    const sqlite = buildDb();
    sqlite.prepare("UPDATE users SET master_password = ? WHERE username = 'anonymous'").run(await sha256("pw"));
    const { getGuest, postGuest, postLogin } = makeApp(sqlite);
    const regularLogin = await postLogin({ username: "anonymous", password: "pw" });
    assert(regularLogin.status === 401, `non-guest level-0 password login returns 401 (got ${regularLogin.status})`);
    const enabled = await getGuest();
    assert((await enabled.json()).enabled === true, "guest option reports enabled");
    const login = await postGuest();
    assert(login.status === 200, `guest login 200 (got ${login.status})`);
    const body = await login.json() as { username?: string; level?: number };
    assert(body.username === "guest" && body.level === 0, "guest session identifies the level-0 account");
    const anonymousSessions = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE username = 'anonymous'").get() as { n: number };
    assert(anonymousSessions.n === 0, "guest login does not select another level-0 account");
    assert((login.headers.get("Set-Cookie") || "").includes("HttpOnly"), "guest login sets an HttpOnly cookie");
    sqlite.prepare("UPDATE user_permissions SET enabled = 0 WHERE level = 0 AND permission = 'browse'").run();
    const disabled = await postGuest();
    assert(disabled.status === 403, `disabled guest login returns 403 (got ${disabled.status})`);
  }

  console.log("\nlogout endpoint wipes the cookie & drops the session row:");
  {
    const sqlite = buildDb();
    const token = "cookie-logout-test";
    insertSession(sqlite, token, "alice", now + 86400);
    const { postLogout, get } = makeApp(sqlite);
    const r = await postLogout(`edgesonic_session=${token}`);
    assert(r.status === 200, `logout 200 (got ${r.status})`);
    const sc = r.headers.get("Set-Cookie") || "";
    assert(sc.includes("Max-Age=0"), `Set-Cookie Max-Age=0 (got ${sc})`);
    // The session row must have been deleted.
    const row = sqlite.prepare("SELECT token FROM sessions WHERE token = ?").get(token);
    assert(!row, `session row deleted after cookie-logout`);
    // Subsequent calls with the same cookie should now 401.
    const r2 = await get("/tag/whoami", "", `edgesonic_session=${token}`);
    assert(r2.status === 401, `post-logout /tag/whoami 401 (got ${r2.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
