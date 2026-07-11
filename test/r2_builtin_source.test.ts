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

// R2 is the built-in storage backend accessed via the native
// MUSIC_BUCKET binding; uploads/clone/hotcache/transcode all hardcode
// song_instances.source_id='r2-local' without ever creating a
// storage_sources row, so it never showed up on the Sources page and had no
// way to be edited. This test covers the fix:
//  1. /sources/list synthesises a virtual r2-local entry when no real row
//    exists yet, so it's always visible.
//  2. If a real r2 row already exists (e.g. a future migration seeds one),
//    list returns that instead of a duplicate synthetic entry.
//  3. /sources/update upserts (INSERT) the built-in row on its first edit
//    instead of 404ing like it would for any other missing id.
//  4. A second edit after that first upsert goes through the normal UPDATE
//    path (no duplicate rows).
//  5. /sources/delete rejects id='r2-local' — it's built-in and un-removable.
//  6. Regular (non-r2) sources are unaffected: still 404 on update-missing,
//    still deletable.
//
// Run: npx tsx test/r2_builtin_source.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { sourcesRoutes } from "../worker/src/endpoints/storage/sources";

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
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      presign_username TEXT, presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER, enabled INTEGER DEFAULT 1, mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, size INTEGER DEFAULT 0, missing INTEGER DEFAULT 0
    );
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_sources', 1);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/storage", sourcesRoutes);
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
    async get(url: string) { return app.fetch(new Request(`http://test${url}`), env); },
  };
}

function xmlAttrs(text: string, tag: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*/?>`, "g");
  let m;
  while ((m = re.exec(text))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    items.push(attrs);
  }
  return items;
}

async function main() {
  console.log("no real r2 row → /sources/list synthesises one:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.get("/storage/sources/list");
    assert(r.status === 200, `200 (got ${r.status})`);
    const sources = xmlAttrs(await r.text(), "source");
    const r2 = sources.find((s) => s.id === "r2-local");
    assert(!!r2, "r2-local entry present");
    assert(r2?.type === "r2", `type=r2 (got ${r2?.type})`);
    assert(r2?.name === "R2", `default name=R2 (got ${r2?.name})`);
    assert(r2?.enabled === "true", "synthesized entry is enabled");
    assert(r2?.mode === "library", "default mode=library");
    const dbRow = sqlite.prepare("SELECT COUNT(*) AS n FROM storage_sources").get() as { n: number };
    assert(dbRow.n === 0, "synthesis does NOT write a row to D1 — it's purely a list-time fallback");
  }

  console.log("\na real r2 row already exists → list returns it, no duplicate synthetic entry:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      `INSERT INTO storage_sources (id, type, name, base_url, root_path, mode, created_at, updated_at)
       VALUES ('r2-local', 'r2', 'My Bucket Alias', '', 'audio/', 'library', 1, 1)`,
    ).run();
    const app = makeApp(sqlite);
    const r = await app.get("/storage/sources/list");
    const sources = xmlAttrs(await r.text(), "source");
    const r2Rows = sources.filter((s) => s.type === "r2");
    assert(r2Rows.length === 1, `exactly one r2 entry (got ${r2Rows.length})`);
    assert(r2Rows[0].name === "My Bucket Alias", `real row's saved name wins (got ${r2Rows[0].name})`);
    assert(r2Rows[0].rootPath === "audio/", `real row's saved root_path wins (got ${r2Rows[0].rootPath})`);
  }

  console.log("\nfirst edit of r2-local upserts (INSERT) instead of 404ing:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/update", { id: "r2-local", name: "Edge Bucket", root_path: "music/" });
    assert(r.status === 200, `200, not 404 (got ${r.status})`);
    const row = sqlite.prepare("SELECT type, name, root_path FROM storage_sources WHERE id='r2-local'").get() as { type: string; name: string; root_path: string };
    assert(row.type === "r2", `inserted row has type=r2 (got ${row.type})`);
    assert(row.name === "Edge Bucket", `name persisted (got ${row.name})`);
    assert(row.root_path === "music/", `root_path persisted (got ${row.root_path})`);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM storage_sources").get() as { n: number }).n;
    assert(count === 1, `exactly 1 row after the upsert (got ${count})`);
  }

  console.log("\nsecond edit after the upsert goes through the normal UPDATE path (no duplicate row):");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    await app.post("/storage/sources/update", { id: "r2-local", name: "Edge Bucket" });
    const r2 = await app.post("/storage/sources/update", { id: "r2-local", name: "Renamed Again" });
    assert(r2.status === 200, `second edit 200 (got ${r2.status})`);
    const rows = sqlite.prepare("SELECT name FROM storage_sources WHERE id='r2-local'").all() as Array<{ name: string }>;
    assert(rows.length === 1, `still exactly 1 row (got ${rows.length})`);
    assert(rows[0].name === "Renamed Again", `second edit's name wins (got ${rows[0].name})`);
  }

  console.log("\n/sources/delete rejects the built-in r2-local id:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    await app.post("/storage/sources/update", { id: "r2-local", name: "Edge Bucket" });
    const r = await app.post("/storage/sources/delete", { id: "r2-local" });
    assert(r.status === 400, `400 rejected (got ${r.status})`);
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM storage_sources WHERE id='r2-local'").get() as { n: number };
    assert(row.n === 1, "row was NOT deleted");
  }

  console.log("\nregular (non-r2) sources unaffected — still 404 on update-missing, still deletable:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      `INSERT INTO storage_sources (id, type, name, base_url, created_at, updated_at)
       VALUES ('wd-1', 'webdav', 'My WebDAV', 'https://dav.example', 1, 1)`,
    ).run();
    const app = makeApp(sqlite);
    const rMissing = await app.post("/storage/sources/update", { id: "does-not-exist", name: "X" });
    assert(rMissing.status === 404, `unknown non-r2 id still 404s (got ${rMissing.status})`);
    const rDelete = await app.post("/storage/sources/delete", { id: "wd-1" });
    assert(rDelete.status === 200, `regular source still deletable (got ${rDelete.status})`);
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM storage_sources WHERE id='wd-1'").get() as { n: number };
    assert(row.n === 0, "wd-1 actually removed");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
