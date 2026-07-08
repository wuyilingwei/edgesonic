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

// Task 076 — work_queue dedup via deterministic id + INSERT OR IGNORE.
//
// Two back-to-back dispatchWorkBatch calls with the same instanceId (same
// dedupKey) must result in exactly one work_queue row, not two. Mixed batches
// (some with dedupKey, some without) keep the random-id path working.
//
// Run: npx tsx test/work_queue_dedup.test.ts

import { DatabaseSync } from "node:sqlite";
import { dispatchWork, dispatchWorkBatch } from "../worker/src/endpoints/edgesonic/work";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; }

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
  return {
    prepare,
    batch: async (s: unknown[]) =>
      Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())),
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  // Mirror of the 052a schema (only the columns dispatchWork writes/reads).
  sqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      required_caps TEXT,
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      max_attempts INTEGER NOT NULL DEFAULT 3,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      claimed_by TEXT,
      claimed_at INTEGER,
      created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
  `);
  return sqlite;
}

async function main() {
  console.log("dispatchWorkBatch with dedupKey: same instanceId → one row:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const inputs = [
      { taskType: "metadata", payload: { instanceId: "si-X" }, dedupKey: "si-X", requiredCaps: ["music-metadata"] },
    ];
    // Two scans in a row — same instance.
    await dispatchWorkBatch(db, inputs);
    await dispatchWorkBatch(db, inputs);

    const rows = sqlite.prepare("SELECT id FROM work_queue").all() as Array<{ id: string }>;
    assert(rows.length === 1, `exactly 1 row (got ${rows.length})`);
    assert(rows[0].id === "wt-metadata-si-X", `deterministic id (got ${rows[0].id})`);
  }

  console.log("\ndispatchWorkBatch with dedupKey: multiple distinct instances → N rows:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const inputs = ["si-A", "si-B", "si-C"].map((id) => ({
      taskType: "metadata",
      payload: { instanceId: id },
      dedupKey: id,
    }));
    await dispatchWorkBatch(db, inputs);
    // Re-dispatch same batch — INSERT OR IGNORE eats them.
    await dispatchWorkBatch(db, inputs);

    const rows = sqlite.prepare("SELECT id FROM work_queue ORDER BY id").all() as Array<{ id: string }>;
    assert(rows.length === 3, `exactly 3 rows after re-dispatch (got ${rows.length})`);
    assert(rows[0].id === "wt-metadata-si-A", "row 0 is si-A");
    assert(rows[1].id === "wt-metadata-si-B", "row 1 is si-B");
    assert(rows[2].id === "wt-metadata-si-C", "row 2 is si-C");
  }

  console.log("\ndispatchWork single without dedupKey: random id, no IGNORE clash:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const id1 = await dispatchWork(db, { taskType: "transcode", payload: { foo: 1 } });
    const id2 = await dispatchWork(db, { taskType: "transcode", payload: { foo: 1 } });
    assert(id1 !== id2, "two distinct random ids returned");
    const rows = sqlite.prepare("SELECT id FROM work_queue").all() as Array<{ id: string }>;
    assert(rows.length === 2, `2 rows (got ${rows.length})`);
    assert(rows.every((r) => r.id.startsWith("wq-")), "ids use legacy wq- prefix when no dedupKey");
  }

  console.log("\nMixed batch (some with dedupKey, some without):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWorkBatch(db, [
      { taskType: "metadata", payload: { x: 1 }, dedupKey: "alpha" },
      { taskType: "transcode", payload: { y: 1 } },
      { taskType: "metadata", payload: { x: 2 }, dedupKey: "beta" },
    ]);
    // Re-dispatch only the deduped ones.
    await dispatchWorkBatch(db, [
      { taskType: "metadata", payload: { x: 1 }, dedupKey: "alpha" },
      { taskType: "metadata", payload: { x: 2 }, dedupKey: "beta" },
    ]);
    const rows = sqlite.prepare("SELECT id FROM work_queue ORDER BY id").all() as Array<{ id: string }>;
    // alpha + beta + 1 random transcode = 3 rows
    assert(rows.length === 3, `3 rows after dedup re-dispatch (got ${rows.length})`);
    assert(rows.some((r) => r.id === "wt-metadata-alpha"), "alpha row present once");
    assert(rows.some((r) => r.id === "wt-metadata-beta"), "beta row present once");
    assert(rows.some((r) => r.id.startsWith("wq-")), "random-id transcode row present");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
