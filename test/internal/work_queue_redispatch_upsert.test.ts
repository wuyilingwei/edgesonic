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

// dedupKey + plain INSERT OR IGNORE is a *one-shot-ever* mechanism:
// once a row with that deterministic id lands in a terminal state
// (completed/failed/canceled), every future dispatch under the same
// dedupKey silently no-ops — the row never comes back to 'queued'. That's
// correct for "don't pile up duplicates while still in flight", but it
// silently defeats force-rescan: resetting song_instances.tag_scanned=0
// and re-walking a source does NOT actually get the already-completed
// instance reprocessed, because its work_queue row's id collides with the
// prior run and INSERT OR IGNORE just skips it.
//
// dispatchWork/dispatchWorkBatch now accept `upsert: true`, which switches
// the INSERT to `ON CONFLICT(id) DO UPDATE` so a stale terminal row gets
// kicked back to 'queued' with attempts/claim state cleared. This test
// exercises both the old (upsert unset/false → still ignored, documenting
// the pre-fix behavior) and new (upsert: true → redispatched) paths against
// a real SQLite engine (node:sqlite) so ON CONFLICT semantics are genuinely
// exercised, not hand-mocked.
//
// Run: npx tsx test/internal/work_queue_redispatch_upsert.test.ts

import { DatabaseSync } from "node:sqlite";
import { dispatchWork, dispatchWorkBatch } from "../../worker/src/endpoints/edgesonic/work";

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
      heartbeat_at INTEGER,
      result_json TEXT,
      error_message TEXT,
      created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
  `);
  return sqlite;
}

function markCompleted(sqlite: DatabaseSync, id: string) {
  sqlite.prepare(
    `UPDATE work_queue SET status='completed', attempts=3, claimed_by='alice',
     claimed_at=111, heartbeat_at=222, result_json='{"ok":true}', error_message=NULL
     WHERE id = ?`,
  ).run(id);
}

function markFailed(sqlite: DatabaseSync, id: string) {
  sqlite.prepare(
    `UPDATE work_queue SET status='failed', attempts=3, claimed_by=NULL,
     claimed_at=NULL, heartbeat_at=NULL, error_message='boom' WHERE id = ?`,
  ).run(id);
}

async function main() {
  console.log("dispatchWork: without upsert, re-dispatching a completed dedupKey row is a no-op (pre-fix behavior):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-A" }, dedupKey: "si-A" });
    markCompleted(sqlite, "wt-metadata-si-A");
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-A" }, dedupKey: "si-A" });
    const row = sqlite.prepare("SELECT status, attempts FROM work_queue WHERE id = ?").get("wt-metadata-si-A") as { status: string; attempts: number };
    assert(row.status === "completed", `row stays 'completed' without upsert (got "${row.status}")`);
    assert(row.attempts === 3, `attempts untouched without upsert (got ${row.attempts})`);
  }

  console.log("\ndispatchWork: upsert=true redispatches a completed row back to 'queued' with cleared claim state:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-B" }, dedupKey: "si-B" });
    markCompleted(sqlite, "wt-metadata-si-B");
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-B", sourceUri: "webdav://x/b.flac" }, dedupKey: "si-B", upsert: true });
    const row = sqlite.prepare(
      "SELECT status, attempts, claimed_by, claimed_at, heartbeat_at, result_json, error_message, payload FROM work_queue WHERE id = ?",
    ).get("wt-metadata-si-B") as {
      status: string; attempts: number; claimed_by: string | null; claimed_at: number | null;
      heartbeat_at: number | null; result_json: string | null; error_message: string | null; payload: string;
    };
    assert(row.status === "queued", `row flipped back to 'queued' (got "${row.status}")`);
    assert(row.attempts === 0, `attempts reset to 0 (got ${row.attempts})`);
    assert(row.claimed_by === null, "claimed_by cleared");
    assert(row.claimed_at === null, "claimed_at cleared");
    assert(row.heartbeat_at === null, "heartbeat_at cleared");
    assert(row.result_json === null, "result_json cleared");
    assert(row.error_message === null, "error_message cleared");
    assert(JSON.parse(row.payload).sourceUri === "webdav://x/b.flac", "payload refreshed to the new dispatch's payload");
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 1, `still exactly one row for this dedupKey (got ${count})`);
  }

  console.log("\ndispatchWork: upsert=true also redispatches a failed row:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-C" }, dedupKey: "si-C" });
    markFailed(sqlite, "wt-metadata-si-C");
    await dispatchWork(db, { taskType: "metadata", payload: { instanceId: "si-C" }, dedupKey: "si-C", upsert: true });
    const row = sqlite.prepare("SELECT status, error_message FROM work_queue WHERE id = ?").get("wt-metadata-si-C") as { status: string; error_message: string | null };
    assert(row.status === "queued", `failed row redispatched to 'queued' (got "${row.status}")`);
    assert(row.error_message === null, "prior error_message cleared");
  }

  console.log("\ndispatchWorkBatch: upsert=true redispatches a mix of completed/failed/never-dispatched rows in one call:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWorkBatch(db, [
      { taskType: "metadata", payload: { instanceId: "si-D1" }, dedupKey: "D1" },
      { taskType: "metadata", payload: { instanceId: "si-D2" }, dedupKey: "D2" },
    ]);
    markCompleted(sqlite, "wt-metadata-D1");
    markFailed(sqlite, "wt-metadata-D2");
    // Re-walk the source: D1/D2 come back plus a brand-new D3.
    await dispatchWorkBatch(db, [
      { taskType: "metadata", payload: { instanceId: "si-D1" }, dedupKey: "D1", upsert: true },
      { taskType: "metadata", payload: { instanceId: "si-D2" }, dedupKey: "D2", upsert: true },
      { taskType: "metadata", payload: { instanceId: "si-D3" }, dedupKey: "D3", upsert: true },
    ]);
    const rows = sqlite.prepare("SELECT id, status FROM work_queue ORDER BY id").all() as Array<{ id: string; status: string }>;
    assert(rows.length === 3, `still 3 rows total, no duplicates (got ${rows.length})`);
    assert(rows.every((r) => r.status === "queued"), `all three rows are 'queued' (got ${rows.map((r) => `${r.id}:${r.status}`).join(", ")})`);
  }

  console.log("\ndispatchWorkBatch: without upsert (default), still-queued row is untouched by re-dispatch (no regression to the common incremental-scan path):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await dispatchWorkBatch(db, [{ taskType: "metadata", payload: { instanceId: "si-E", v: 1 }, dedupKey: "E" }]);
    await dispatchWorkBatch(db, [{ taskType: "metadata", payload: { instanceId: "si-E", v: 2 }, dedupKey: "E" }]);
    const row = sqlite.prepare("SELECT payload FROM work_queue WHERE id = ?").get("wt-metadata-E") as { payload: string };
    assert(JSON.parse(row.payload).v === 1, "still-queued row's original payload untouched (INSERT OR IGNORE, not upsert)");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
