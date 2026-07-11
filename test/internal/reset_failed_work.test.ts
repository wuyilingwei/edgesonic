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
// Smoke test for the "browser bundle stuck failed → unstick" recovery hatch.
// Mirrors the maintenance_reclaim shim (node:sqlite + Hono + handwritten D1
// stub) so the suite stays self-contained and runs under plain `npx tsx`.
//
// Coverage:
//  1. Mixed status batch — failed rows flipped to queued; other statuses left
//    alone. attempts=0, error_message=NULL, claimed_*=NULL on the reset rows.
//  2. task_type=metadata filter — only failed-metadata rows are touched;
//    failed-scan rows in the same batch stay failed.
//  3. No failed rows → ok:true, reset:0 (idempotent).
//  4. Non-admin (level=2) → 403, nothing mutated.
//
// Run: npx tsx test/internal/reset_failed_work.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { maintenanceRoutes } from "../../worker/src/endpoints/edgesonic/maintenance";

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
      payload TEXT,
      required_caps TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_by TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER,
      result_json TEXT,
      error_message TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      created_at INTEGER DEFAULT 0,
      expires_at INTEGER
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (3, 'maintenance_reset', 1, 0),
      (2, 'maintenance_reset', 0, 0),
      (1, 'maintenance_reset', 0, 0),
      (0, 'maintenance_reset', 0, 0);
  `);
  return sqlite;
}

interface SeedOpts {
  id: string;
  status: string;
  taskType?: string;
  attempts?: number;
  errorMessage?: string | null;
  claimedBy?: string | null;
}
function seedRow(sqlite: DatabaseSync, opts: SeedOpts) {
  const nowRow = sqlite.prepare("SELECT unixepoch() AS now").get() as { now: number };
  // Failed rows in real life carry the residue of their last claim attempt:
  // a stale claimed_by + last heartbeat + an error_message. Seeding those
  // lets us assert the reset actually wipes them.
  const claimed_by = opts.claimedBy === undefined ? "worker-x" : opts.claimedBy;
  const claimed_at = claimed_by ? nowRow.now - 60 : null;
  const heartbeat_at = claimed_by ? nowRow.now - 60 : null;
  sqlite.prepare(`
    INSERT INTO work_queue
      (id, task_type, payload, status, claimed_by, claimed_at, heartbeat_at,
       attempts, max_attempts, error_message, created_at)
    VALUES (?, ?, '{}', ?, ?, ?, ?, ?, 3, ?, ?)
  `).run(
    opts.id,
    opts.taskType ?? "metadata",
    opts.status,
    claimed_by,
    claimed_at,
    heartbeat_at,
    opts.attempts ?? 3,
    opts.errorMessage ?? (opts.status === "failed" ? "bundle exploded" : null),
    nowRow.now - 600,
  );
}

function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", maintenanceRoutes);
  const kvStore = new Map<string, string>();
  const kv = {
    async get(key: string) { return kvStore.has(key) ? kvStore.get(key)! : null; },
    async put(key: string, value: string) { kvStore.set(key, value); },
    async delete(key: string) { kvStore.delete(key); },
  };
  const env = { DB: makeD1(sqlite), KV: kv };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

interface ResetBody {
  ok: boolean;
  reset?: number;
  taskType?: string;
  error?: string;
}

async function main() {
  console.log("Mixed batch — only failed → queued, residue cleared:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "f-1", status: "failed",   attempts: 3 });
    seedRow(sqlite, { id: "f-2", status: "failed",   attempts: 3 });
    seedRow(sqlite, { id: "q-1", status: "queued",   attempts: 0, claimedBy: null });
    seedRow(sqlite, { id: "c-1", status: "claimed",  attempts: 1 });
    seedRow(sqlite, { id: "d-1", status: "done",     attempts: 1 });

    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/resetFailedWork", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as ResetBody;
    assert(body.ok === true, "ok:true");
    assert(body.reset === 2, `reset=2 (got ${body.reset})`);
    assert(body.taskType === undefined, "no taskType echo when filter unused");

    const rows = sqlite.prepare(
      "SELECT id, status, attempts, error_message, claimed_by, claimed_at, heartbeat_at FROM work_queue ORDER BY id",
    ).all() as Array<{ id: string; status: string; attempts: number; error_message: string | null; claimed_by: string | null; claimed_at: number | null; heartbeat_at: number | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    assert(byId["f-1"].status === "queued", "f-1 → queued");
    assert(byId["f-2"].status === "queued", "f-2 → queued");
    assert(byId["f-1"].attempts === 0, `f-1 attempts=0 (got ${byId["f-1"].attempts})`);
    assert(byId["f-2"].attempts === 0, `f-2 attempts=0 (got ${byId["f-2"].attempts})`);
    assert(byId["f-1"].error_message === null, "f-1 error_message cleared");
    assert(byId["f-1"].claimed_by === null && byId["f-1"].claimed_at === null && byId["f-1"].heartbeat_at === null,
      "f-1 claimed_* + heartbeat_at all cleared");

    assert(byId["q-1"].status === "queued" && byId["q-1"].attempts === 0, "queued row untouched");
    assert(byId["c-1"].status === "claimed" && byId["c-1"].attempts === 1, "claimed row untouched");
    assert(byId["d-1"].status === "done", "done row untouched");
  }

  console.log("\ntask_type filter — only matching failed rows reset:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "m-1", status: "failed", taskType: "metadata" });
    seedRow(sqlite, { id: "m-2", status: "failed", taskType: "metadata" });
    seedRow(sqlite, { id: "s-1", status: "failed", taskType: "scan" });
    seedRow(sqlite, { id: "s-2", status: "queued", taskType: "scan" });

    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/resetFailedWork?task_type=metadata", {});
    const body = await r.json() as ResetBody;
    assert(body.ok === true, "ok:true");
    assert(body.reset === 2, `reset=2 (got ${body.reset})`);
    assert(body.taskType === "metadata", `taskType echoed (got ${body.taskType})`);

    const byId = Object.fromEntries(
      (sqlite.prepare("SELECT id, status, task_type FROM work_queue ORDER BY id").all() as Array<{ id: string; status: string; task_type: string }>)
        .map((r) => [r.id, r]),
    );
    assert(byId["m-1"].status === "queued", "m-1 metadata → queued");
    assert(byId["m-2"].status === "queued", "m-2 metadata → queued");
    assert(byId["s-1"].status === "failed", "s-1 scan stays failed (filter)");
    assert(byId["s-2"].status === "queued", "s-2 scan stays queued");
  }

  console.log("\nNo failed rows → ok with reset=0:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "q-only", status: "queued", attempts: 0, claimedBy: null });
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/resetFailedWork", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as ResetBody;
    assert(body.ok === true && body.reset === 0, `reset=0 (got ${body.reset})`);
  }

  console.log("\nNon-admin (level=2) → 403, no mutation (permissionMiddleware XML):");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "f-x", status: "failed" });
    const { post } = makeApp(sqlite, { username: "user", level: 2 });
    const r = await post("/edgesonic/maintenance/resetFailedWork", {});
    assert(r.status === 403, `403 (got ${r.status})`);
    const text = await r.text();
    assert(text.includes("Not authorized"),
      `body mentions Not authorized (got "${text.slice(0, 80)}")`);
    const row = sqlite.prepare("SELECT status FROM work_queue WHERE id='f-x'").get() as { status: string };
    assert(row.status === "failed", "row not mutated on 403");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
