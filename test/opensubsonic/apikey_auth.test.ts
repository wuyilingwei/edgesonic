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
// Regression test for authMiddleware's apiKeyAuthentication resolution.
//
// Before this fix, `u` (username) was required unconditionally before the
// apiKey branch ever ran — a client presenting a bare `apiKey=` with no `u`
// got "Missing username" even though api_keys.api_key is the D1 primary key
// and already identifies exactly one account. That's non-compliant with the
// OpenSubsonic apiKeyAuthentication extension EdgeSonic advertises (clients
// using it are allowed to omit u/p/t/s). The fix resolves `username` from
// the api_keys row before the missing-username check when `u` is absent,
// while still cross-checking `u` against the key's owner when both are sent
// (so a request can't ride someone else's key under a different claimed
// username).
//
// Coverage:
//  1. apiKey only (no u) → 200, authMethod=apikey, username resolved from key
//  2. apiKey + matching u → 200 (backward-compat path, unchanged)
//  3. apiKey + mismatched u (someone else's key, wrong claimed username) → 401
//  4. Unknown/invalid apiKey, no u → 401 "Missing username" (nothing to resolve)
//  5. No credentials at all → 401 "Missing username"
//  6. Plain password auth (q.p, no apiKey) still works — apiKey resolution
//     doesn't interfere with the unrelated credential paths
//
// Run: npx tsx test/opensubsonic/apikey_auth.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/src/auth";

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
    CREATE TABLE api_keys (
      api_key TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE subsonic_credentials (
      username TEXT NOT NULL, password TEXT NOT NULL, stream_proxy_strategy TEXT, last_used INTEGER
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER);
    INSERT INTO users (username, master_password, level, enabled) VALUES
      ('alice', 'alicepw', 1, 1),
      ('bob', 'bobpw', 1, 1);
    INSERT INTO api_keys (api_key, username) VALUES ('key-alice-123', 'alice');
    INSERT INTO subsonic_credentials (username, password, stream_proxy_strategy) VALUES ('alice', 'alicepw', 'always');
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("/rest/*", authMiddleware);
  app.get("/rest/ping", (c) => c.json({
    ok: true,
    username: c.get("user")?.username,
    authMethod: c.get("authMethod"),
  }));
  const env = { DB: makeD1(sqlite) };
  return {
    async get(qs: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test/rest/ping?${qs}`), env as any);
    },
  };
}

async function main() {
  console.log("apiKey only, no u → resolves username from the key:");
  {
    const { get } = makeApp(buildDb());
    const r = await get("apiKey=key-alice-123");
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { username?: string; authMethod?: string };
    assert(body.username === "alice", `username=alice (got ${body.username})`);
    assert(body.authMethod === "apikey", `authMethod=apikey (got ${body.authMethod})`);
  }

  console.log("\napiKey + matching u → still works (backward compat):");
  {
    const { get } = makeApp(buildDb());
    const r = await get("u=alice&apiKey=key-alice-123");
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { username?: string; authMethod?: string };
    assert(body.username === "alice", `username=alice (got ${body.username})`);
    assert(body.authMethod === "apikey", `authMethod=apikey (got ${body.authMethod})`);
  }

  console.log("\napiKey + mismatched u (someone else's key, wrong claimed username) → 401:");
  {
    const { get } = makeApp(buildDb());
    const r = await get("u=bob&apiKey=key-alice-123");
    assert(r.status === 401, `401 (got ${r.status})`);
  }

  console.log("\nUnknown apiKey, no u → 401 (nothing to resolve, 'Missing username'):");
  {
    const { get } = makeApp(buildDb());
    const r = await get("apiKey=not-a-real-key");
    assert(r.status === 401, `401 (got ${r.status})`);
    const text = await r.text();
    assert(/Missing username/.test(text), `mentions Missing username (got "${text.slice(0, 120)}")`);
  }

  console.log("\nNo credentials at all → 401 Missing username:");
  {
    const { get } = makeApp(buildDb());
    const r = await get("");
    assert(r.status === 401, `401 (got ${r.status})`);
    const text = await r.text();
    assert(/Missing username/.test(text), `mentions Missing username (got "${text.slice(0, 120)}")`);
  }

  console.log("\nPlain password auth (q.p, no apiKey) unaffected:");
  {
    const { get } = makeApp(buildDb());
    const r = await get("u=alice&p=alicepw");
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { username?: string; authMethod?: string };
    assert(body.username === "alice", `username=alice (got ${body.username})`);
    assert(body.authMethod === "subsonic_cred", `authMethod=subsonic_cred (got ${body.authMethod})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
