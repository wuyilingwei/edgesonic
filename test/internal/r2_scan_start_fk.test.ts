// Regression for a production 500: GET /storage/scan/start?id=r2-local&force=1
// returned `D1_ERROR: FOREIGN KEY constraint failed` the first time anyone
// scanned R2 before ever having saved a real edit for it.
//
// Root cause: scan_jobs.source_id has a real FOREIGN KEY to
// storage_sources(id) (Schema.sql §18). startScanHandler's synthetic R2
// fallback (id='r2-local', mirroring sources.ts synthesizeR2Row) only ever
// existed in memory — the real storage_sources row wasn't materialized until
// asyncScanR2Source's own upsert ran *inside* ctx.waitUntil, which is AFTER
// the synchronous scan_jobs INSERT already ran (so getScanStatus can see the
// job as "running" immediately). D1 enforces foreign_keys by default; the
// earlier r2_scan.test.ts / r2_builtin_source.test.ts unit tests never
// caught this because neither exercised startScanHandler as an HTTP route
// with a FK-enforcing schema — one drove asyncScanR2Source directly (skips
// the scan_jobs INSERT ordering entirely), the other only touched
// sources.ts's own routes.
//
// This test mounts the real scanRoutes Hono router against a schema with
// PRAGMA foreign_keys = ON and the actual scan_jobs FK, so a regression here
// fails loudly instead of silently passing like before.
//
// Run: npx tsx test/internal/r2_scan_start_fk.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { scanRoutes } from "../../worker/src/endpoints/storage/scan";

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
  return {
    prepare,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async batch(stmts: any[]) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  // This is the whole point of the test — D1 enforces FKs, node:sqlite
  // doesn't by default. Without this pragma the bug would NOT reproduce.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER, enabled INTEGER DEFAULT 1, mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
      total_items INTEGER NOT NULL DEFAULT 0, scanned_items INTEGER NOT NULL DEFAULT 0,
      error_message TEXT, started_at INTEGER NOT NULL DEFAULT (unixepoch()), ended_at INTEGER,
      FOREIGN KEY (source_id) REFERENCES storage_sources(id) ON DELETE CASCADE
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, song_count INTEGER DEFAULT 0, size INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT, artist_id TEXT, title TEXT, sort_title TEXT, track INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT NOT NULL, source_type TEXT DEFAULT 'original',
      storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0,
      source_etag TEXT, source_last_modified INTEGER, tag_scanned INTEGER DEFAULT 0,
      missing INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE work_queue (id TEXT PRIMARY KEY);
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_sources', 1);
  `);
  return sqlite;
}

interface MockCtx {
  waitUntil: (p: Promise<unknown>) => void;
  awaitAll: () => Promise<unknown[]>;
}
function makeCtx(): MockCtx {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { promises.push(p); },
    awaitAll() { return Promise.all(promises); },
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/storage", scanRoutes);
  return app;
}

async function main() {
  console.log("GET /storage/scan/start?id=r2-local&force=1 with NO real storage_sources row (first-ever R2 scan):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const env = { DB: db, MUSIC_BUCKET: { async list() { return { objects: [], truncated: false }; } } };
    const ctx = makeCtx();
    const app = makeApp();

    const req = new Request("http://test/storage/scan/start?id=r2-local&force=1");
    const res = await app.fetch(req, env, ctx as unknown as ExecutionContext);
    const body = await res.text();

    assert(res.status === 200, `200 (got ${res.status}): ${body.slice(0, 300)}`);
    assert(!/error/i.test(body) || /scanning="true"/.test(body), `no error in response body: ${body.slice(0, 300)}`);
    assert(/scanning="true"/.test(body), "scanResult reports scanning=true");

    // The synchronous part of the handler must have inserted BOTH the
    // storage_sources row and the scan_jobs row without a FK violation.
    const srcRow = sqlite.prepare("SELECT id, type FROM storage_sources WHERE id='r2-local'").get() as { id: string; type: string } | undefined;
    assert(!!srcRow, "storage_sources row for r2-local was materialized synchronously");
    assert(srcRow?.type === "r2", `type=r2 (got ${srcRow?.type})`);

    const jobRow = sqlite.prepare("SELECT id, source_id, status FROM scan_jobs WHERE source_id='r2-local'").get() as { id: string; status: string } | undefined;
    assert(!!jobRow, "scan_jobs row was inserted (no FOREIGN KEY constraint failure)");

    // Let the background asyncScanR2Source (queued via ctx.waitUntil) finish.
    await ctx.awaitAll();
    const jobAfter = sqlite.prepare("SELECT status FROM scan_jobs WHERE source_id='r2-local'").get() as { status: string };
    assert(jobAfter.status === "completed", `background scan completed (got ${jobAfter.status})`);
  }

  console.log("\na real r2 row already exists → no duplicate insert, saved name untouched:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      `INSERT INTO storage_sources (id, type, name, base_url, root_path, mode, enabled, created_at, updated_at)
       VALUES ('r2-local', 'r2', 'My Bucket', '', '', 'library', 1, 1, 1)`,
    ).run();
    const db = makeD1(sqlite);
    const env = { DB: db, MUSIC_BUCKET: { async list() { return { objects: [], truncated: false }; } } };
    const ctx = makeCtx();
    const app = makeApp();

    const req = new Request("http://test/storage/scan/start?id=r2-local");
    const res = await app.fetch(req, env, ctx as unknown as ExecutionContext);
    assert(res.status === 200, `200 (got ${res.status})`);
    await ctx.awaitAll();

    const rows = sqlite.prepare("SELECT name FROM storage_sources WHERE id='r2-local'").all() as Array<{ name: string }>;
    assert(rows.length === 1, `still exactly 1 storage_sources row (got ${rows.length})`);
    assert(rows[0].name === "My Bucket", `saved name untouched (got ${rows[0].name})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
