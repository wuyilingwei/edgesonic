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

// 260: lastfmFetchUser (per-user recentTracks/lovedTracks/userInfo/topTracks)
// must be fully isolated from the system-level lastfm_api_key. Before 260 it
// silently fell back to the system key when a user hadn't configured their
// own — meaning every user's personal listening history rode on the admin's
// shared key/quota. This test locks in that the fallback is gone.
//
// Run: npx tsx test/internal/lastfm_user_isolation.test.ts

import { DatabaseSync } from "node:sqlite";
import { getUserInfo, LastfmUnconfigured } from "../../worker/src/lib/lastfm";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1(sqlite: DatabaseSync) {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: unknown[] = [];
    return {
      bind(...args: unknown[]) { boundArgs = args; return this; },
      async first<T = unknown>(): Promise<T | null> {
        const row = stmt.get(...(boundArgs as never[]));
        return (row ?? null) as T | null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: unknown }> {
        const rows = stmt.all(...(boundArgs as never[])) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...(boundArgs as never[]));
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: Array<{ run(): Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())) };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE user_settings (username TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (username, key));
    CREATE TABLE lastfm_cache (cache_key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
    -- system-level key IS configured — the whole point of this test is that
    -- a user without their own key must NOT be able to ride on it.
    INSERT INTO feature_strings (key, value) VALUES ('lastfm_api_key', 'SYSTEM_KEY');
  `);
  return sqlite;
}

interface FetchCall { url: string; }
let fetchCalls: FetchCall[] = [];
const originalFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    fetchCalls.push({ url });
    return new Response(JSON.stringify({ user: { name: "someone" } }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

async function main() {
  installFetchStub();

  console.log("getUserInfo: user with no personal API key throws LastfmUnconfigured, even though system key is set:");
  {
    fetchCalls = [];
    const sqlite = buildDb();
    const env = { DB: makeD1(sqlite) } as unknown as Env;
    let threw: unknown = null;
    try {
      await getUserInfo(env, "someone_lastfm", "alice");
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof LastfmUnconfigured, `throws LastfmUnconfigured (got: ${threw})`);
    assert(fetchCalls.length === 0, "no outbound fetch — never even tried the system key");
  }

  console.log("\ngetUserInfo: user WITH their own key uses it, not the system key:");
  {
    fetchCalls = [];
    const sqlite = buildDb();
    sqlite.exec(
      `INSERT INTO user_settings (username, key, value) VALUES ('alice', 'lastfm_api_key', 'ALICE_KEY');`,
    );
    const env = { DB: makeD1(sqlite) } as unknown as Env;
    const info = await getUserInfo(env, "someone_lastfm", "alice");
    assert(info?.name === "someone", "call succeeded and returned data");
    assert(fetchCalls.length === 1, `exactly one outbound fetch (got ${fetchCalls.length})`);
    assert(fetchCalls[0].url.includes("api_key=ALICE_KEY"), "used alice's own key");
    assert(!fetchCalls[0].url.includes("SYSTEM_KEY"), "system key never appears in the request");
  }

  console.log("\ngetUserInfo: no edgesonicUsername context (no per-user identity) also throws, never touches system key:");
  {
    fetchCalls = [];
    const sqlite = buildDb();
    const env = { DB: makeD1(sqlite) } as unknown as Env;
    let threw: unknown = null;
    try {
      await getUserInfo(env, "someone_lastfm", undefined);
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof LastfmUnconfigured, "throws LastfmUnconfigured");
    assert(fetchCalls.length === 0, "no outbound fetch");
  }

  restoreFetch();

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nAll lastfm_user_isolation tests passed.");
  }
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
