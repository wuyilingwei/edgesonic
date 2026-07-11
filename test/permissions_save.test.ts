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

// POST /edgesonic/permissions/save (Settings → Permissions explicit
// Save button, replacing the old real-time-per-toggle /permissions/update
// RPH era). Two responsibilities per call:
//  1. Batch-UPDATE the given (level, permission, enabled) rows into D1
//    always, the durable source of truth.
//  2. Best-effort: if CF_API_TOKEN/CF_ACCOUNT_ID are configured, push the
//    FULL current matrix (not just this request's patch) as the
//    PERMISSIONS_OVERRIDE Workers Secret via the CF API, so
//    permissionMiddleware/hasPermission can skip the D1 round-trip on
//    every subsequent request. A push failure must not fail the request.
//
// Run: npx tsx test/permissions_save.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { permissionsRoutes } from "../worker/src/endpoints/edgesonic/permissions";

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
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (3, 'manage_permissions', 1),
      (2, 'manage_permissions', 0),
      (3, 'manage_sources', 1),
      (2, 'manage_sources', 0),
      (1, 'stream', 1);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Fetch mock — same shape as test/cf_integration.test.ts.
// ---------------------------------------------------------------------------
interface FetchExpectation {
  match: (req: Request, url: string) => boolean;
  reply: (req: Request) => Response | Promise<Response>;
  capture?: { body?: unknown };
}
let expectations: FetchExpectation[] = [];
const realFetch = global.fetch;
function installMock() {
  expectations = [];
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    for (let i = 0; i < expectations.length; i++) {
      const e = expectations[i];
      if (e.match(req, req.url)) {
        if (e.capture) {
          try { e.capture.body = await req.clone().json(); } catch { e.capture.body = undefined; }
        }
        expectations.splice(i, 1);
        return e.reply(req);
      }
    }
    throw new Error(`Unexpected fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}
function uninstallMock() { global.fetch = realFetch; }
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeApp(sqlite: DatabaseSync, extraEnv: Record<string, string | undefined> = {}, level = 3) {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", permissionsRoutes);
  const env = { DB: makeD1(sqlite), ...extraEnv };
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
  console.log("D1-only path (no CF_API_TOKEN configured): D1 updated, envPushed=false:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r = await post("/edgesonic/permissions/save", {
      permissions: [
        { level: 2, name: "manage_sources", enabled: true },
        { level: 3, name: "manage_sources", enabled: false },
      ],
    });
    assert(r.status === 200, `200 status (got ${r.status})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await r.json() as any;
    assert(body.ok === true, "ok:true");
    assert(body.saved === 2, `saved=2 (got ${body.saved})`);
    assert(body.envPushed === false, "envPushed=false when CF not configured");

    const rows = sqlite.prepare("SELECT level, enabled FROM user_permissions WHERE permission='manage_sources' ORDER BY level").all() as Array<{ level: number; enabled: number }>;
    assert(rows.find((r) => r.level === 2)?.enabled === 1, "L2 manage_sources flipped to enabled=1");
    assert(rows.find((r) => r.level === 3)?.enabled === 0, "L3 manage_sources flipped to enabled=0");
  }

  console.log("\nCF configured + secret push succeeds: envPushed=true, PUT body carries the FULL merged matrix:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc", WORKER_NAME: "edgesonic" });
    installMock();
    const capture: { body?: unknown } = {};
    expectations.push({
      match: (req, url) => req.method === "PUT" && url.includes("/accounts/acc/workers/scripts/edgesonic/secrets"),
      reply: () => jsonResp({ success: true, result: { name: "PERMISSIONS_OVERRIDE" } }),
      capture,
    });
    const r = await post("/edgesonic/permissions/save", {
      permissions: [{ level: 2, name: "manage_sources", enabled: true }],
    });
    uninstallMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await r.json() as any;
    assert(body.envPushed === true, `envPushed=true (got ${JSON.stringify(body)})`);
    assert(body.envError === undefined, "no envError on success");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pushed = capture.body as any;
    assert(pushed.name === "PERMISSIONS_OVERRIDE", `secret name correct (got ${pushed?.name})`);
    assert(pushed.type === "secret_text", "secret type=secret_text");
    const matrix = JSON.parse(pushed.text);
    // Full matrix, not just the one row we patched — includes untouched rows too.
    assert(matrix["3"]["manage_permissions"] === true, "matrix includes untouched L3 manage_permissions=true");
    assert(matrix["2"]["manage_sources"] === true, "matrix reflects the just-saved L2 manage_sources=true");
    assert(matrix["1"]["stream"] === true, "matrix includes untouched L1 stream=true");
  }

  console.log("\nCF configured but secret push fails: still ok:true (D1 already saved), envPushed=false + envError set:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" });
    installMock();
    expectations.push({
      match: (req) => req.method === "PUT",
      reply: () => jsonResp({ success: false, errors: [{ message: "insufficient permissions" }] }, 403),
    });
    const r = await post("/edgesonic/permissions/save", {
      permissions: [{ level: 2, name: "manage_sources", enabled: true }],
    });
    uninstallMock();
    assert(r.status === 200, `still D1 write already succeeded (got ${r.status})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await r.json() as any;
    assert(body.ok === true, "ok:true despite CF push failure");
    assert(body.envPushed === false, "envPushed=false");
    assert(typeof body.envError === "string" && body.envError.includes("insufficient permissions"), `envError surfaces the CF error (got "${body.envError}")`);

    const row = sqlite.prepare("SELECT enabled FROM user_permissions WHERE level=2 AND permission='manage_sources'").get() as { enabled: number };
    assert(row.enabled === 1, "D1 row was still updated even though the secret push failed");
  }

  console.log("\nvalidation errors:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite);
    const r1 = await post("/edgesonic/permissions/save", { permissions: [] });
    assert(r1.status === 400, `empty array → 400 (got ${r1.status})`);
    const r2 = await post("/edgesonic/permissions/save", {});
    assert(r2.status === 400, `missing permissions → 400 (got ${r2.status})`);
    const r3 = await post("/edgesonic/permissions/save", { permissions: [{ level: 9, name: "manage_sources", enabled: true }] });
    assert(r3.status === 400, `level out of range → 400 (got ${r3.status})`);
    const r4 = await post("/edgesonic/permissions/save", { permissions: [{ level: 2, name: "", enabled: true }] });
    assert(r4.status === 400, `empty permission name → 400 (got ${r4.status})`);
  }

  console.log("\npermission gate: L2 without manage_permissions → 403:");
  {
    const sqlite = buildDb(); // L2 manage_permissions=0 per seed
    const { post } = makeApp(sqlite, {}, 2);
    const r = await post("/edgesonic/permissions/save", { permissions: [{ level: 2, name: "manage_sources", enabled: true }] });
    assert(r.status === 403, `403 (got ${r.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
