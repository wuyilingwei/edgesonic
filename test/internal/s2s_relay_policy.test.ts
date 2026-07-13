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

// 178 (OpenSubsonic #254): S2S relay policy derivation + outbound
// X-OpenSubsonic-Path loop-prevention header.
//
// Coverage:
//  1. getServerRelayPolicy: explicit server_relay_policy wins; otherwise derives
//     from allow_being_proxied (on→allow, off→deny); no-cache honoured.
//  2. The subsonic adapter emits X-OpenSubsonic-Path (and X-EdgeSonic-Chain) with
//     the full chronological chain incl. our own INSTANCE_ID appended.
//
// Run: npx tsx test/internal/s2s_relay_policy.test.ts

import { DatabaseSync } from "node:sqlite";
import { getServerRelayPolicy } from "../../worker/src/utils/features";
import { createSubsonicAdapter } from "../../worker/src/adapters/subsonic";

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
    let bound: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { bound = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> { return (stmt.get(...bound) ?? null) as T | null; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>() { return { results: stmt.all(...bound) as T[], success: true, meta: {} }; },
      async run() { const i = stmt.run(...bound); return { success: true, meta: { changes: Number(i.changes ?? 0) } }; },
    };
  }
  return { prepare };
}

function featuresDb(allowBeingProxied: number, relayPolicy?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  `);
  db.prepare("INSERT INTO features (key, value) VALUES ('allow_being_proxied', ?)").run(allowBeingProxied);
  if (relayPolicy !== undefined) {
    db.prepare("INSERT INTO feature_strings (key, value) VALUES ('server_relay_policy', ?)").run(relayPolicy);
  }
  return db;
}
// Fresh env per call → features.ts's per-env cache never collides across cases.
const envFor = (db: DatabaseSync) => ({ DB: makeD1(db) }) as never;

async function main() {
  console.log("getServerRelayPolicy — derivation:");
  {
    assert((await getServerRelayPolicy(envFor(featuresDb(1)))) === "allow", "allow_being_proxied=1, unset → allow");
    assert((await getServerRelayPolicy(envFor(featuresDb(0)))) === "deny", "allow_being_proxied=0, unset → deny");
    assert((await getServerRelayPolicy(envFor(featuresDb(1, "no-cache")))) === "no-cache", "explicit no-cache honoured");
    assert((await getServerRelayPolicy(envFor(featuresDb(1, "deny")))) === "deny", "explicit deny overrides allow_being_proxied=1");
    assert((await getServerRelayPolicy(envFor(featuresDb(0, "allow")))) === "allow", "explicit allow overrides allow_being_proxied=0");
    assert((await getServerRelayPolicy(envFor(featuresDb(1, "garbage")))) === "allow", "invalid explicit value falls back to derivation");
  }

  console.log("\nsubsonic adapter — outbound X-OpenSubsonic-Path:");
  {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE storage_sources (id TEXT, type TEXT, base_url TEXT, username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1);
      INSERT INTO storage_sources (id, type, base_url, username, password, root_path, enabled)
        VALUES ('s1', 'subsonic', 'https://up.example.com', 'u', 'p', '', 1);
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let captured: { url?: string; headers?: any } = {};
    const realFetch = global.fetch;
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), headers: init?.headers };
      return new Response("bytes", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }) as typeof fetch;

    try {
      const adapter = createSubsonicAdapter(makeD1(db), { instanceId: "me-uuid", incomingChain: ["origin-uuid", "proxy1-uuid"] });
      await adapter.stream("subsonic://rest/stream?id=123");
    } finally {
      global.fetch = realFetch;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = captured.headers as Record<string, string>;
    assert(h["X-OpenSubsonic-Path"] === "origin-uuid,proxy1-uuid,me-uuid",
      `X-OpenSubsonic-Path = chronological chain incl. our id (got ${h["X-OpenSubsonic-Path"]})`);
    assert(h["X-EdgeSonic-Chain"] === "origin-uuid,proxy1-uuid,me-uuid", "X-EdgeSonic-Chain matches (both emitted)");
    assert((captured.url || "").includes("esChain=origin-uuid%2Cproxy1-uuid%2Cme-uuid"), "esChain query also carries the chain");
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
