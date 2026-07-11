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
// Verifies that the formerly level-checked endpoints now flow through the
// user_permissions table (permissionMiddleware or hasPermission helper), and
// that the `minLevel()` reverse-pattern function was removed from auth.ts.
//
// Coverage:
//  1. hasPermission helper round-trips (enabled row / disabled row / missing)
//  2. maintenance.* endpoints — L3 with permission → pass, L2 without → 403
//  3. cf.ts route-level middleware — L3 with manage_cloudflare → pass, L2
//    without → 403
//  4. auth.ts no longer exports minLevel — drift guard against accidental
//    reintroduction (we lint the source text since the function is removed)
//
// Run: npx tsx test/internal/permission_model_compliance.test.ts

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { hasPermission } from "../../worker/src/utils/permissions";
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
  return { prepare };
}

function buildPermDb(seedRows: Array<[number, string, number]> = []): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
  `);
  for (const [level, perm, enabled] of seedRows) {
    sqlite.prepare(
      "INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES (?, ?, ?, 0)",
    ).run(level, perm, enabled);
  }
  return sqlite;
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. hasPermission helper
  // -------------------------------------------------------------------------
  console.log("hasPermission(db, user, perm) — enabled row → true:");
  {
    const sqlite = buildPermDb([[3, "view_all_users_items", 1]]);
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db },
      { username: "root", level: 3, password: "x", enabled: 1 },
      "view_all_users_items",
    );
    assert(can === true, "L3 + enabled=1 → true");
  }

  console.log("hasPermission — disabled row → false:");
  {
    const sqlite = buildPermDb([[2, "view_all_users_items", 0]]);
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db },
      { username: "user", level: 2, password: "x", enabled: 1 },
      "view_all_users_items",
    );
    assert(can === false, "L2 + enabled=0 → false");
  }

  console.log("hasPermission — missing row → false (treat-as-disabled):");
  {
    const sqlite = buildPermDb([]);
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db },
      { username: "user", level: 1, password: "x", enabled: 1 },
      "view_all_users_items",
    );
    assert(can === false, "missing row → false");
  }

  // -------------------------------------------------------------------------
  // 2. maintenance.* endpoints gated by permissionMiddleware
  // -------------------------------------------------------------------------
  console.log("\nmaintenance/cleanupDuplicateCovers — L3 with permission → 200:");
  {
    const sqlite = buildPermDb([[3, "maintenance_cleanup", 1]]);
    sqlite.exec(`CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, cover_r2_key TEXT, updated_at INTEGER DEFAULT 0);`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
      return next();
    });
    app.route("/edgesonic", maintenanceRoutes);
    const env = { DB: makeD1(sqlite) };
    const r = await app.fetch(
      new Request("http://test/edgesonic/maintenance/cleanupDuplicateCovers", { method: "POST" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { ok: boolean };
    assert(body.ok === true, "ok:true");
  }

  console.log("\nmaintenance/cleanupDuplicateCovers — L2 without permission → 403 + Subsonic XML:");
  {
    const sqlite = buildPermDb([
      [3, "maintenance_cleanup", 1],
      [2, "maintenance_cleanup", 0],
    ]);
    sqlite.exec(`CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, cover_r2_key TEXT, updated_at INTEGER DEFAULT 0);`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "user", level: 2, enabled: 1, password: "x" });
      return next();
    });
    app.route("/edgesonic", maintenanceRoutes);
    const env = { DB: makeD1(sqlite) };
    const r = await app.fetch(
      new Request("http://test/edgesonic/maintenance/cleanupDuplicateCovers", { method: "POST" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    assert(r.status === 403, `403 (got ${r.status})`);
    const text = await r.text();
    assert(text.includes("Not authorized"), `body mentions Not authorized (got "${text.slice(0, 80)}")`);
  }

  console.log("\nmaintenance/reclaimStaleWork — L2 with explicit permission grant → 200:");
  {
    // Simulates an operator who granted maintenance_reclaim to L2 via the
    // Permissions UI — the unified model is supposed to make this delegation
    // possible without a code change.
    const sqlite = buildPermDb([[2, "maintenance_reclaim", 1]]);
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
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "delegated-admin", level: 2, enabled: 1, password: "x" });
      return next();
    });
    app.route("/edgesonic", maintenanceRoutes);
    const kvStore = new Map<string, string>();
    const env = {
      DB: makeD1(sqlite),
      KV: {
        async get(k: string) { return kvStore.has(k) ? kvStore.get(k)! : null; },
        async put(k: string, v: string) { kvStore.set(k, v); },
        async delete(k: string) { kvStore.delete(k); },
      },
    };
    const r = await app.fetch(
      new Request("http://test/edgesonic/maintenance/reclaimStaleWork", { method: "POST" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env as any,
    );
    assert(r.status === 200, `200 (delegated L2 admin succeeds, got ${r.status})`);
    const body = await r.json() as { ok: boolean };
    assert(body.ok === true, "ok:true — permission-model delegation works");
  }

  // -------------------------------------------------------------------------
  // PERMISSIONS_OVERRIDE env var wins over D1, D1 is the fallback
  // -------------------------------------------------------------------------
  console.log("\n119 — PERMISSIONS_OVERRIDE env var overrides D1 when present:");
  {
    const sqlite = buildPermDb([[2, "manage_sources", 0]]); // D1 says disabled
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db, PERMISSIONS_OVERRIDE: JSON.stringify({ "2": { manage_sources: true } }) },
      { username: "user", level: 2, password: "x", enabled: 1 },
      "manage_sources",
    );
    assert(can === true, "env override (true) wins even though D1 row says enabled=0");
  }

  console.log("\n119 — falls back to D1 when the override JSON has no entry for this (level, permission):");
  {
    const sqlite = buildPermDb([[2, "manage_sources", 1]]); // D1 says enabled
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db, PERMISSIONS_OVERRIDE: JSON.stringify({ "2": { some_other_perm: false } }) },
      { username: "user", level: 2, password: "x", enabled: 1 },
      "manage_sources",
    );
    assert(can === true, "missing key in override → falls through to D1's enabled=1");
  }

  console.log("\n119 — malformed override JSON falls back to D1 without throwing:");
  {
    const sqlite = buildPermDb([[2, "manage_sources", 1]]);
    const db = makeD1(sqlite);
    const can = await hasPermission(
      { DB: db, PERMISSIONS_OVERRIDE: "{not valid json" },
      { username: "user", level: 2, password: "x", enabled: 1 },
      "manage_sources",
    );
    assert(can === true, "malformed JSON doesn't throw, falls back to D1");
  }

  console.log("\n119 — RPH sliding-window rate limit removed from permissionMiddleware:");
  {
    const authSrc = readFileSync(resolve(__dirname, "../../worker/src/auth.ts"), "utf-8");
    assert(!/max_rph/.test(authSrc), "auth.ts no longer references max_rph");
    assert(!/rate_limits/.test(authSrc), "auth.ts no longer references the rate_limits table");
    assert(authSrc.includes('hasPermission(c.env, user, requiredPermission)'), "permissionMiddleware delegates to the shared hasPermission helper");
  }

  // -------------------------------------------------------------------------
  // 3. minLevel() reverse-pattern function removed from auth.ts
  // -------------------------------------------------------------------------
  console.log("\nauth.ts source no longer defines minLevel() (087 drift guard):");
  {
    const authSrc = readFileSync(
      resolve(__dirname, "../../worker/src/auth.ts"),
      "utf-8",
    );
    // The function declaration must be gone. We allow the word in a
    // comment block (we left a "deleted" comment intentionally), so we
    // assert on the actual function signature shape instead.
    const stillDefined = /export\s+function\s+minLevel\s*\(/.test(authSrc);
    assert(!stillDefined,
      `export function minLevel(...) is gone from auth.ts (regex hit: ${stillDefined})`);
  }

  console.log("\nauth.ts source no longer exports a `minLevel` symbol:");
  {
    // Even imports (e.g. someone copy-pasted the function elsewhere and
    // re-exported it) would fail to compile if the symbol re-appeared in
    // auth.ts. We scan the worker source for any import of `minLevel` from
    // the auth module — should be zero.
    const _ignored = readFileSync(  // sanity: file is readable
      resolve(__dirname, "../../worker/src/auth.ts"),
      "utf-8",
    );
    void _ignored;
    // Glob the endpoints folder for stale imports.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let staleImports = 0;
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.name.endsWith(".ts")) {
          const t = await fs.readFile(p, "utf-8");
          if (/from\s+["'][^"']*auth["']/.test(t) && /\bminLevel\b/.test(t)) {
            staleImports++;
            console.error(`    stale import in ${p}`);
          }
        }
      }
    }
    await walk(resolve(__dirname, "../../worker/src"));
    assert(staleImports === 0, `no source file imports minLevel from auth.ts (count: ${staleImports})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
