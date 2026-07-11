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
// Regression test for authMiddleware's credential-type boundary and the
// browser-session auto-renew behavior. Both already exist in worker/src/auth.ts
// (needsSession gate + renewSessionIfNeeded) but had no direct test coverage
// before this file.
//
// Boundary rule (auth.ts): `/tag/*`, `/storage/*`, `/edgesonic/*` are
// management surfaces and require authMethod === "session" — a leaked
// apiKey or Subsonic client password (subsonic_credentials) must never reach
// them, only a real browser login session. `/rest/*` (the Subsonic protocol
// surface) accepts any of the three credential kinds.
//
// Coverage:
//  1. apiKey → 200 on /rest/*, 403 on /tag/*, /storage/*, /edgesonic/*
//  2. subsonic_cred (t+s against subsonic_credentials) → 200 on /rest/*,
//     403 on all three management prefixes
//  3. session (t+s against the sessions table, i.e. the web app's own login
//     token used as a Subsonic credential) → 200 on /rest/* AND all three
//     management prefixes (the one credential kind allowed everywhere)
//  4. Session auto-renew: expires_at bumped to now+24h when under the 20h
//     threshold; left untouched when comfortably far from expiry (no
//     unnecessary D1 write)
//
// Run: npx tsx test/internal/auth_session_boundary.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";
import { md5 } from "../../worker/src/utils/md5";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

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
    INSERT INTO users (username, master_password, level, enabled) VALUES ('alice', 'hash', 1, 1);
    INSERT INTO api_keys (api_key, username) VALUES ('key-alice', 'alice');
    INSERT INTO subsonic_credentials (username, password, stream_proxy_strategy) VALUES ('alice', 'clientpw', 'always');
  `);
  return sqlite;
}

function insertSession(sqlite: DatabaseSync, token: string, expiresAt: number) {
  sqlite.prepare(
    "INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES (?, 'alice', ?, '', ?, ?)",
  ).run(`sess-${token}`, token, expiresAt, Math.floor(Date.now() / 1000));
}

function makeApp(sqlite: DatabaseSync) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  // Mirrors worker/src/index.ts's real mounting exactly (same four prefixes).
  app.use("/rest/*", authMiddleware);
  app.use("/tag/*", authMiddleware);
  app.use("/storage/*", authMiddleware);
  app.use("/edgesonic/*", authMiddleware);
  const ok = (c: import("hono").Context) => c.json({ ok: true, authMethod: c.get("authMethod") });
  app.get("/rest/ping", ok);
  app.get("/tag/whoami", ok);
  app.get("/storage/whoami", ok);
  app.get("/edgesonic/whoami", ok);
  const env = { DB: makeD1(sqlite) };
  return {
    async get(path: string, qs: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${path}?${qs}`), env as any);
    },
  };
}

async function main() {
  console.log("apiKey → 200 on /rest, 403 on /tag /storage /edgesonic:");
  {
    const { get } = makeApp(buildDb());
    const rest = await get("/rest/ping", "apiKey=key-alice");
    assert(rest.status === 200, `/rest 200 (got ${rest.status})`);
    for (const p of ["/tag/whoami", "/storage/whoami", "/edgesonic/whoami"]) {
      const r = await get(p, "apiKey=key-alice");
      assert(r.status === 403, `${p} 403 (got ${r.status})`);
    }
  }

  console.log("\nsubsonic_cred (client password, t+s) → 200 on /rest, 403 on management prefixes:");
  {
    const sqlite = buildDb();
    const salt = "s1";
    const token = md5("clientpw" + salt);
    const { get } = makeApp(sqlite);
    const rest = await get("/rest/ping", `u=alice&t=${token}&s=${salt}`);
    assert(rest.status === 200, `/rest 200 (got ${rest.status})`);
    const restBody = await rest.json() as { authMethod?: string };
    assert(restBody.authMethod === "subsonic_cred", `authMethod=subsonic_cred (got ${restBody.authMethod})`);
    for (const p of ["/tag/whoami", "/storage/whoami", "/edgesonic/whoami"]) {
      const salt2 = "s2";
      const token2 = md5("clientpw" + salt2);
      const r = await get(p, `u=alice&t=${token2}&s=${salt2}`);
      assert(r.status === 403, `${p} 403 (got ${r.status})`);
    }
  }

  console.log("\nsession (web login token as t+s) → 200 on /rest AND all three management prefixes:");
  {
    const sqlite = buildDb();
    const sessionToken = "web-session-token-abc";
    insertSession(sqlite, sessionToken, Math.floor(Date.now() / 1000) + 86400);
    const { get } = makeApp(sqlite);

    const salt = "sess-salt";
    const token = md5(sessionToken + salt);
    const rest = await get("/rest/ping", `u=alice&t=${token}&s=${salt}`);
    assert(rest.status === 200, `/rest 200 (got ${rest.status})`);
    const restBody = await rest.json() as { authMethod?: string };
    assert(restBody.authMethod === "session", `authMethod=session (got ${restBody.authMethod})`);

    for (const p of ["/tag/whoami", "/storage/whoami", "/edgesonic/whoami"]) {
      const s = `salt-${p}`;
      const t = md5(sessionToken + s);
      const r = await get(p, `u=alice&t=${t}&s=${s}`);
      assert(r.status === 200, `${p} 200 for session (got ${r.status})`);
    }
  }

  console.log("\nSession auto-renew: bumped when <20h remain:");
  {
    const sqlite = buildDb();
    const token = "renew-me";
    const now = Math.floor(Date.now() / 1000);
    const soonExpiry = now + 3600; // 1h left — well under the 20h threshold
    insertSession(sqlite, token, soonExpiry);
    const { get } = makeApp(sqlite);
    const salt = "rs";
    const t = md5(token + salt);
    const r = await get("/rest/ping", `u=alice&t=${t}&s=${salt}`);
    assert(r.status === 200, `200 (got ${r.status})`);

    const row = sqlite.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(token) as { expires_at: number };
    assert(row.expires_at > soonExpiry, `expires_at bumped forward (was ${soonExpiry}, now ${row.expires_at})`);
    assert(row.expires_at >= now + 86000, `bumped to ~+24h (got ${row.expires_at}, now=${now})`);
  }

  console.log("\nSession auto-renew: untouched when comfortably far from expiry:");
  {
    const sqlite = buildDb();
    const token = "no-renew-needed";
    const now = Math.floor(Date.now() / 1000);
    const farExpiry = now + 82800; // 23h left — above the 20h threshold
    insertSession(sqlite, token, farExpiry);
    const { get } = makeApp(sqlite);
    const salt = "nr";
    const t = md5(token + salt);
    const r = await get("/rest/ping", `u=alice&t=${t}&s=${salt}`);
    assert(r.status === 200, `200 (got ${r.status})`);

    const row = sqlite.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(token) as { expires_at: number };
    assert(row.expires_at === farExpiry, `expires_at left untouched (still ${row.expires_at}, was ${farExpiry})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
