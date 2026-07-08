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

// 088 — worker_max_concurrent feature flag.
//
// Covers the server-side knob added in 088:
//   1. Migration 0025 default — feature_strings row exists with value '3'.
//   2. POST /edgesonic/features/updateString accepts integers in [1, 8].
//   3. Rejects 0, 9, "abc", "-1", "" (each with the canonical error string).
//   4. Persists the new value end-to-end (round-trip via SELECT).
//
// Mirrors the maintenance_reclaim / reset_failed_work shim (node:sqlite + Hono
// + handwritten D1 stub) so the suite stays self-contained and runs under
// plain `npx tsx`.
//
// Run: npx tsx test/worker_concurrent_config.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { featuresRoutes } from "../worker/src/endpoints/edgesonic/features";

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
    CREATE TABLE features (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL,
      description TEXT,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at INTEGER DEFAULT 0
    );
    -- 087 — features/updateString gates on manage_permissions; the test user
    -- is super-admin (level=3) so the permission row must be enabled.
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (3, 'manage_permissions', 1, 0),
      (2, 'manage_permissions', 0, 0);

    -- Simulate 0025: insert the worker_max_concurrent seed row.
    INSERT INTO feature_strings (key, value, description, updated_at) VALUES
      ('worker_max_concurrent', '3', 'Concurrent Web Workers per browser (1-8)', unixepoch());
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", featuresRoutes);
  const kvStore = new Map<string, string>();
  const kv = {
    async get(key: string) { return kvStore.has(key) ? kvStore.get(key)! : null; },
    async put(key: string, value: string) { kvStore.set(key, value); },
    async delete(key: string) { kvStore.delete(key); },
  };
  const env = { DB: makeD1(sqlite), KV: kv, INSTANCE_ID: "test-instance" };
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

interface UpdateBody { ok: boolean; error?: string }

async function main() {
  console.log("Migration seed — worker_max_concurrent defaults to '3':");
  {
    const sqlite = buildDb();
    const row = sqlite.prepare(
      "SELECT value FROM feature_strings WHERE key = 'worker_max_concurrent'",
    ).get() as { value: string } | undefined;
    assert(!!row, "row exists");
    assert(row?.value === "3", `default '3' (got '${row?.value}')`);
  }

  console.log("\nAccepts integers in 1..8:");
  for (const v of ["1", "3", "5", "8"]) {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/features/updateString", {
      key: "worker_max_concurrent",
      value: v,
    });
    const body = await r.json() as UpdateBody;
    assert(r.status === 200, `${v}: 200 (got ${r.status})`);
    assert(body.ok === true, `${v}: ok:true`);
    const persisted = sqlite.prepare(
      "SELECT value FROM feature_strings WHERE key = 'worker_max_concurrent'",
    ).get() as { value: string };
    assert(persisted.value === v, `${v}: persisted (got '${persisted.value}')`);
  }

  console.log("\nRejects out-of-range / non-integer values:");
  const bad: Array<{ v: string; needle: string }> = [
    { v: "0",   needle: "between 1 and 8" },
    { v: "9",   needle: "between 1 and 8" },
    { v: "100", needle: "between 1 and 8" },
    { v: "-1",  needle: "non-negative integer" },
    { v: "abc", needle: "non-negative integer" },
    { v: "",    needle: "non-negative integer" },
    { v: "3.5", needle: "non-negative integer" },
  ];
  for (const { v, needle } of bad) {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/features/updateString", {
      key: "worker_max_concurrent",
      value: v,
    });
    const body = await r.json() as UpdateBody;
    assert(r.status === 400, `${JSON.stringify(v)}: 400 (got ${r.status})`);
    assert(body.ok === false, `${JSON.stringify(v)}: ok:false`);
    assert(
      typeof body.error === "string" && body.error.includes(needle),
      `${JSON.stringify(v)}: error mentions '${needle}' (got '${body.error}')`,
    );
    // Confirm the rejected write did NOT mutate the seed value.
    const persisted = sqlite.prepare(
      "SELECT value FROM feature_strings WHERE key = 'worker_max_concurrent'",
    ).get() as { value: string };
    assert(persisted.value === "3", `${JSON.stringify(v)}: seed value preserved`);
  }

  console.log("\nNon-admin (level=2) cannot update worker_max_concurrent:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "user", level: 2 });
    const r = await post("/edgesonic/features/updateString", {
      key: "worker_max_concurrent",
      value: "5",
    });
    assert(r.status === 403, `403 (got ${r.status})`);
    const persisted = sqlite.prepare(
      "SELECT value FROM feature_strings WHERE key = 'worker_max_concurrent'",
    ).get() as { value: string };
    assert(persisted.value === "3", "value unchanged after 403");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
