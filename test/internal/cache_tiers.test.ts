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

// per-source cache tier + eviction (evictExpired / evictForRoom /
// resolveTierConfig / getSourceCacheTier) unit tests.
//
// Covers:
//  • getSourceCacheTier: no row → 'off'; valid row → that tier; garbage value → 'off'
//  • resolveTierConfig: 'off' → null; missing feature_strings row → hardcoded
//    defaults; malformed JSON → defaults; valid JSON → those values
//  • evictExpired: only removes rows past their TTL, for the given origin
//    source only — a different source's expired rows are untouched
//  • evictForRoom: evicts least-recently-used first (NULL last_accessed_at
//    sorts before any real timestamp); stops as soon as it fits; never
//    touches another origin source's cached rows even if over its own budget
//
// Run: npx tsx test/internal/cache_tiers.test.ts

import { DatabaseSync } from "node:sqlite";
import {
  getSourceCacheTier, resolveTierConfig, evictExpired, evictForRoom,
} from "../../worker/src/utils/cacheTiers";

declare global { type D1Database = unknown; type Env = unknown; }

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
      async first<T = unknown>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
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
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, cache_tier TEXT NOT NULL DEFAULT 'off'
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT NOT NULL,
      source_type TEXT DEFAULT 'original', parent_instance_id TEXT,
      storage_uri TEXT NOT NULL, size INTEGER, missing INTEGER DEFAULT 0,
      expires_at INTEGER, last_accessed_at INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT,
      updated_at INTEGER DEFAULT 0
    );
  `);
  return sqlite;
}

function makeEnv(sqlite: DatabaseSync) {
  const deletedKeys: string[] = [];
  const env = {
    DB: makeD1(sqlite),
    MUSIC_BUCKET: {
      async delete(key: string) { deletedKeys.push(key); },
    },
  };
  return { env, deletedKeys };
}

// Seeds one "original" instance on `originSourceId` plus one "cached" mirror
// pointing at it via parent_instance_id — the shape evictExpired/evictForRoom
// actually query (they join cached → parent to recover the origin source).
function seedCachedPair(
  sqlite: DatabaseSync,
  opts: {
    id: string; originSourceId: string; size: number;
    expiresAt: number | null; lastAccessedAt: number | null; createdAt: number;
  },
) {
  const origId = `orig-${opts.id}`;
  sqlite.prepare(
    `INSERT INTO song_instances (id, source_id, source_type, storage_uri, size, missing, created_at)
     VALUES (?, ?, 'original', ?, ?, 0, ?)`,
  ).run(origId, opts.originSourceId, `webdav://${origId}`, opts.size, opts.createdAt);
  sqlite.prepare(
    `INSERT INTO song_instances
       (id, source_id, source_type, parent_instance_id, storage_uri, size, missing,
        expires_at, last_accessed_at, created_at)
     VALUES (?, 'r2-local', 'cached', ?, ?, ?, 0, ?, ?, ?)`,
  ).run(opts.id, origId, `r2://cache/webdav/${opts.id}`, opts.size, opts.expiresAt, opts.lastAccessedAt, opts.createdAt);
}

function cachedIds(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare("SELECT id FROM song_instances WHERE source_type = 'cached' ORDER BY id").all() as Array<{ id: string }>)
    .map((r) => r.id);
}

async function main() {
  console.log("getSourceCacheTier:");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, cache_tier) VALUES ('wd-1', 'webdav', 'standard');
      INSERT INTO storage_sources (id, type, cache_tier) VALUES ('wd-2', 'webdav', 'bogus');
    `);
    const { env } = makeEnv(sqlite);
    assert(await getSourceCacheTier(env, "wd-1") === "standard", "configured tier returned");
    assert(await getSourceCacheTier(env, "wd-2") === "off", "unrecognized stored value defaults to off");
    assert(await getSourceCacheTier(env, "does-not-exist") === "off", "no row → off");
  }

  console.log("\nresolveTierConfig:");
  {
    // features.ts memoizes feature_strings per-env-object for 60s (see
    // utils/features.ts MEM_TTL_MS) — a fresh env per assertion here mirrors
    // a fresh request/isolate seeing the just-written D1 row, same as
    // production would after the memoization window lapses.
    const sqlite = buildDb();
    assert(await resolveTierConfig(makeEnv(sqlite).env, "off") === null, "'off' resolves to null");

    const std = await resolveTierConfig(makeEnv(sqlite).env, "standard");
    assert(std !== null && std.budgetBytes === 2048 * 1024 * 1024, `missing row falls back to default budget (got ${std?.budgetBytes})`);
    assert(std !== null && std.maxFileBytes === 300 * 1024 * 1024, "missing row falls back to default per-file cap");
    assert(std !== null && std.ttlSeconds === 30 * 24 * 60 * 60, "missing row falls back to default TTL");

    sqlite.prepare("INSERT INTO feature_strings (key, value) VALUES ('cache_tier_extended', ?)")
      .run(JSON.stringify({ budgetMb: 5000, maxFileMb: 700, ttlDays: 2 }));
    const ext = await resolveTierConfig(makeEnv(sqlite).env, "extended");
    assert(ext !== null && ext.budgetBytes === 5000 * 1024 * 1024, "custom JSON budget honoured");
    assert(ext !== null && ext.maxFileBytes === 700 * 1024 * 1024, "custom JSON per-file cap honoured");
    assert(ext !== null && ext.ttlSeconds === 2 * 24 * 60 * 60, "custom JSON TTL honoured");

    sqlite.prepare("INSERT INTO feature_strings (key, value) VALUES ('cache_tier_standard', 'not json')").run();
    const std2 = await resolveTierConfig(makeEnv(sqlite).env, "standard");
    assert(std2 !== null && std2.budgetBytes === 2048 * 1024 * 1024, "malformed JSON falls back to default");
  }

  console.log("\nevictExpired:");
  {
    const sqlite = buildDb();
    const now = 1_000_000;
    // wd-1: one expired, one still fresh
    seedCachedPair(sqlite, { id: "c1", originSourceId: "wd-1", size: 100, expiresAt: now - 10, lastAccessedAt: now - 10, createdAt: now - 100 });
    seedCachedPair(sqlite, { id: "c2", originSourceId: "wd-1", size: 100, expiresAt: now + 1000, lastAccessedAt: now, createdAt: now - 50 });
    // wd-2: also expired, but a different origin source
    seedCachedPair(sqlite, { id: "c3", originSourceId: "wd-2", size: 100, expiresAt: now - 10, lastAccessedAt: now - 10, createdAt: now - 100 });

    const { env, deletedKeys } = makeEnv(sqlite);
    const n = await evictExpired(env, "wd-1", now);
    assert(n === 1, `evicted exactly 1 row for wd-1 (got ${n})`);
    assert(deletedKeys.includes("cache/webdav/c1"), "R2 object for expired row was deleted");
    const remaining = cachedIds(sqlite);
    assert(remaining.includes("c2"), "fresh row for wd-1 survives");
    assert(remaining.includes("c3"), "wd-2's expired row is untouched by a wd-1 sweep (per-source scoping)");
    assert(!remaining.includes("c1"), "expired row actually removed from D1");
  }

  console.log("\nevictForRoom — LRU order, NULL-first, per-source isolation:");
  {
    const sqlite = buildDb();
    const now = 1_000_000;
    // wd-1: 3 cached rows, 100 bytes each = 300 bytes total, right at budget.
    seedCachedPair(sqlite, { id: "c1", originSourceId: "wd-1", size: 100, expiresAt: now + 1000, lastAccessedAt: now - 300, createdAt: now - 300 });
    seedCachedPair(sqlite, { id: "c2", originSourceId: "wd-1", size: 100, expiresAt: now + 1000, lastAccessedAt: null, createdAt: now - 200 });
    seedCachedPair(sqlite, { id: "c3", originSourceId: "wd-1", size: 100, expiresAt: now + 1000, lastAccessedAt: now - 100, createdAt: now - 100 });
    // wd-2: also at its own budget — must not be touched by a wd-1 eviction
    seedCachedPair(sqlite, { id: "d1", originSourceId: "wd-2", size: 100, expiresAt: now + 1000, lastAccessedAt: now - 500, createdAt: now - 500 });

    const { env, deletedKeys } = makeEnv(sqlite);
    // Budget 300, adding 100 more bytes → over budget by 100 → evict exactly 1.
    const n = await evictForRoom(env, "wd-1", 100, { budgetBytes: 300, maxFileBytes: 1_000_000, ttlSeconds: 999_999 });
    assert(n === 1, `evicted exactly 1 row to fit (got ${n})`);
    assert(deletedKeys.includes("cache/webdav/c2"), "NULL last_accessed_at evicted before any real timestamp");
    const remaining = cachedIds(sqlite);
    assert(remaining.includes("c1") && remaining.includes("c3"), "the two rows with real timestamps survive");
    assert(remaining.includes("d1"), "wd-2's row is untouched by a wd-1 eviction (per-source budget)");
  }

  console.log("\nevictForRoom — already under budget → no-op:");
  {
    const sqlite = buildDb();
    const now = 1_000_000;
    seedCachedPair(sqlite, { id: "c1", originSourceId: "wd-1", size: 100, expiresAt: now + 1000, lastAccessedAt: now, createdAt: now });
    const { env, deletedKeys } = makeEnv(sqlite);
    const n = await evictForRoom(env, "wd-1", 50, { budgetBytes: 1000, maxFileBytes: 1_000_000, ttlSeconds: 999_999 });
    assert(n === 0, `nothing evicted when already under budget (got ${n})`);
    assert(deletedKeys.length === 0, "no R2 deletes issued");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
