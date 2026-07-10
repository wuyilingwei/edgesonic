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

// 118 — POST /tag/rescan (Library.vue batch toolbar "重新扫描" action).
// Given a set of song master ids, resets tag_scanned=0 on their 'original'
// instances (skipping transcoded/cached derivatives) and force-redispatches
// a work_queue metadata task per instance with upsert:true, so an instance
// whose prior task already reached a terminal state actually comes back to
// 'queued' instead of being silently ignored by dedupKey collision.
//
// Harness mirrors test/batch_write_tags.test.ts (in-memory SQLite shimmed as
// D1, real Hono route, session-auth injected) extended with source_type on
// song_instances and a work_queue table.
//
// Run: npx tsx test/tag_rescan.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tagEditRoutes } from "../worker/src/endpoints/tag/write";

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
  return { prepare, batch: async (stmts: unknown[]) => Promise.all(stmts.map((s) => (s as { run: () => Promise<unknown> }).run())) };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0, PRIMARY KEY (level, permission)
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      title TEXT NOT NULL, track INTEGER, duration INTEGER,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'original',
      storage_uri TEXT NOT NULL, suffix TEXT, size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued', max_attempts INTEGER NOT NULL DEFAULT 3,
      attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
      claimed_by TEXT, claimed_at INTEGER, heartbeat_at INTEGER,
      result_json TEXT, error_message TEXT,
      created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_tags', 1, 0);

    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-1', 'ar-1', 'Song One', 1, 180);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-2', 'al-1', 'ar-1', 'Song Two', 2, 200);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-3', 'al-1', 'ar-1', 'Transcode Only', 3, 210);

    -- sg-1: already tag_scanned=1, will be reset by rescan
    INSERT INTO song_instances (id, master_id, source_type, storage_uri, suffix, size, tag_scanned)
      VALUES ('inst-1', 'sg-1', 'original', 'webdav://src/1.flac', 'flac', 5000, 1);
    -- sg-2: original + a transcoded derivative — only the original should be targeted
    INSERT INTO song_instances (id, master_id, source_type, storage_uri, suffix, size, tag_scanned)
      VALUES ('inst-2', 'sg-2', 'original', 'webdav://src/2.flac', 'flac', 6000, 1);
    INSERT INTO song_instances (id, master_id, source_type, storage_uri, suffix, size, tag_scanned)
      VALUES ('inst-2t', 'sg-2', 'transcoded', 'r2://cache/2.mp3', 'mp3', 3000, 1);
    -- sg-3: transcoded-only master (e.g. original went missing) — should be skipped entirely
    INSERT INTO song_instances (id, master_id, source_type, storage_uri, suffix, size, tag_scanned)
      VALUES ('inst-3t', 'sg-3', 'transcoded', 'r2://cache/3.mp3', 'mp3', 3000, 1);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", tagEditRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
  };
}

async function main() {
  console.log("happy path: two masters, original instances rescanned, transcoded skipped:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r = await post("/tag/rescan", { ids: ["sg-1", "sg-2"] });
    assert(r.status === 200, `200 status (got ${r.status})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await r.json() as any;
    assert(body.ok === true, "body.ok true");
    assert(body.dispatched === 2, `dispatched=2 (one original instance per master) (got ${body.dispatched})`);
    assert(body.skipped === 0, `skipped=0 (got ${body.skipped})`);

    const scanned = sqlite.prepare("SELECT id, tag_scanned FROM song_instances ORDER BY id").all() as Array<{ id: string; tag_scanned: number }>;
    const byId = new Map(scanned.map((r) => [r.id, r.tag_scanned]));
    assert(byId.get("inst-1") === 0, "inst-1 (original) reset to tag_scanned=0");
    assert(byId.get("inst-2") === 0, "inst-2 (original) reset to tag_scanned=0");
    assert(byId.get("inst-2t") === 1, "inst-2t (transcoded) NOT touched — still tag_scanned=1");

    const queue = sqlite.prepare("SELECT id, status, payload FROM work_queue ORDER BY id").all() as Array<{ id: string; status: string; payload: string }>;
    assert(queue.length === 2, `2 work_queue rows created (got ${queue.length})`);
    assert(queue.every((q) => q.status === "queued"), "both rows status='queued'");
    assert(queue.some((q) => q.id === "wt-metadata-inst-1"), "deterministic id for inst-1");
    assert(queue.some((q) => q.id === "wt-metadata-inst-2"), "deterministic id for inst-2");
    assert(!queue.some((q) => q.id === "wt-metadata-inst-2t"), "no work_queue row for the transcoded derivative");
    const p1 = JSON.parse(queue.find((q) => q.id === "wt-metadata-inst-1")!.payload);
    assert(p1.sourceUri === "webdav://src/1.flac", "payload carries the original instance's storage_uri");
  }

  console.log("\nmaster with only a transcoded instance is skipped, not errored:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r = await post("/tag/rescan", { ids: ["sg-1", "sg-3"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await r.json() as any;
    assert(body.ok === true, "still ok:true when one of several ids has nothing eligible");
    assert(body.dispatched === 1, `dispatched=1 (only sg-1's original) (got ${body.dispatched})`);
    assert(body.skipped === 1, `skipped=1 (sg-3 has no original instance) (got ${body.skipped})`);
  }

  console.log("\nall-ids-ineligible → 404, no work_queue rows created:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r = await post("/tag/rescan", { ids: ["sg-3"] });
    assert(r.status === 404, `404 status (got ${r.status})`);
    const queue = sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number };
    assert(queue.n === 0, "no work_queue rows created");
  }

  console.log("\nredispatch: an already-completed row is upserted back to 'queued' (the whole point of this endpoint):");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    await post("/tag/rescan", { ids: ["sg-1"] });
    sqlite.prepare(
      `UPDATE work_queue SET status='completed', attempts=3, claimed_by='bob',
       result_json='{"ok":true}' WHERE id='wt-metadata-inst-1'`,
    ).run();
    const before = sqlite.prepare("SELECT status FROM work_queue WHERE id='wt-metadata-inst-1'").get() as { status: string };
    assert(before.status === "completed", "sanity: row is completed before the second rescan");

    const r2 = await post("/tag/rescan", { ids: ["sg-1"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body2 = await r2.json() as any;
    assert(body2.ok === true && body2.dispatched === 1, `second rescan reports dispatched=1 (got ${JSON.stringify(body2)})`);
    const after = sqlite.prepare("SELECT status, attempts, claimed_by, result_json FROM work_queue WHERE id='wt-metadata-inst-1'").get() as
      { status: string; attempts: number; claimed_by: string | null; result_json: string | null };
    assert(after.status === "queued", `row flipped back to 'queued' (got "${after.status}")`);
    assert(after.attempts === 0, "attempts reset");
    assert(after.claimed_by === null, "claim cleared");
    assert(after.result_json === null, "stale result cleared");
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 1, `still exactly 1 work_queue row, not a duplicate (got ${count})`);
  }

  console.log("\nvalidation errors:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r1 = await post("/tag/rescan", { ids: [] });
    assert(r1.status === 400, `empty ids → 400 (got ${r1.status})`);
    const r2 = await post("/tag/rescan", {});
    assert(r2.status === 400, `missing ids → 400 (got ${r2.status})`);
    const tooMany = Array.from({ length: 51 }, (_, i) => `sg-${i}`);
    const r3 = await post("/tag/rescan", { ids: tooMany });
    assert(r3.status === 400, `>50 ids → 400 (got ${r3.status})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b3 = await r3.json() as any;
    assert(/limit/i.test(b3.error), `cap mentioned in error (got ${b3.error})`);
    const r4 = await post("/tag/rescan", { ids: ["sg-ghost"] });
    assert(r4.status === 404, `unknown master id (no instances at all) → 404 (got ${r4.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
