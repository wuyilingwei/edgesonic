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

// 089 S2 — Source mode tests.
//
// Covers:
//   • sources/add validates mode (library | sync_only; invalid → 400)
//   • sources/add default mode is 'library'
//   • sources/update accepts mode change
//   • sources/list emits mode attribute
//   • asyncScanSource with mode='sync_only' skips artist/album/master/instance inserts
//     but still increments added counter and updates last_sync
//
// Run: npx tsx test/source_mode.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { sourcesRoutes } from "../worker/src/endpoints/storage/sources";
import { asyncScanSource, parseMultistatus } from "../worker/src/endpoints/storage/scan";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim backed by node:sqlite
// ---------------------------------------------------------------------------
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
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: any }> {
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare };
}

// ---------------------------------------------------------------------------
// Schema + seed (mirrors 0001 + 0003 + 0005 + 0023 + 0026)
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL,
      username TEXT,
      password TEXT,
      password_encrypted TEXT,
      presign_username TEXT,
      presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER,
      enabled INTEGER DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_rph INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, size INTEGER DEFAULT 0, missing INTEGER DEFAULT 0
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES (2, 'manage_sources', 1, 0);
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES (3, 'manage_sources', 1, 0);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
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
    async get(url: string) {
      return app.fetch(new Request(`http://test${url}`), env);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: parse XML attr from response text
// ---------------------------------------------------------------------------
async function xmlAttr(resp: Response, attr: string): Promise<string | null> {
  const text = await resp.text();
  const m = new RegExp(`${attr}="([^"]*)"`, "i").exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Tests — sources/add mode
// ---------------------------------------------------------------------------
async function main() {
  // ── default mode is 'library' ─────────────────────────────────────────────
  console.log("\nsources/add default mode:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/add", {
      type: "webdav", base_url: "https://dav.example", name: "default-mode",
    });
    assert(r.status === 200, `200 (got ${r.status})`);
    const row = sqlite.prepare("SELECT mode FROM storage_sources LIMIT 1").get() as { mode: string };
    assert(row.mode === "library", `mode='library' (got '${row.mode}')`);
  }

  // ── explicit mode='sync_only' ─────────────────────────────────────────────
  console.log("\nsources/add mode='sync_only':");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/add", {
      type: "webdav", base_url: "https://dav.example", name: "sync-only", mode: "sync_only",
    });
    assert(r.status === 200, `200 (got ${r.status})`);
    const row = sqlite.prepare("SELECT mode FROM storage_sources LIMIT 1").get() as { mode: string };
    assert(row.mode === "sync_only", `mode='sync_only' (got '${row.mode}')`);
  }

  // ── invalid mode → 400 ────────────────────────────────────────────────────
  console.log("\nsources/add invalid mode → 400:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/add", {
      type: "webdav", base_url: "https://dav.example", mode: "bad_mode",
    });
    assert(r.status === 400, `400 (got ${r.status})`);
  }

  // ── sources/update mode ───────────────────────────────────────────────────
  console.log("\nsources/update mode:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "INSERT INTO storage_sources (id, type, name, base_url, mode, created_at, updated_at) VALUES (?, 'webdav', ?, ?, 'library', 0, 0)"
    ).run("src1", "test", "https://dav.example");
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/update", { id: "src1", mode: "sync_only" });
    assert(r.status === 200, `200 (got ${r.status})`);
    const row = sqlite.prepare("SELECT mode FROM storage_sources WHERE id='src1'").get() as { mode: string };
    assert(row.mode === "sync_only", `mode updated to 'sync_only' (got '${row.mode}')`);
  }

  // ── sources/update invalid mode → 400 ────────────────────────────────────
  console.log("\nsources/update invalid mode → 400:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "INSERT INTO storage_sources (id, type, name, base_url, mode, created_at, updated_at) VALUES (?, 'webdav', ?, ?, 'library', 0, 0)"
    ).run("src2", "test", "https://dav.example");
    const app = makeApp(sqlite);
    const r = await app.post("/storage/sources/update", { id: "src2", mode: "invalid" });
    assert(r.status === 400, `400 (got ${r.status})`);
  }

  // ── sources/list emits mode attr ──────────────────────────────────────────
  console.log("\nsources/list emits mode:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "INSERT INTO storage_sources (id, type, name, base_url, mode, created_at, updated_at) VALUES (?, 'webdav', ?, ?, 'sync_only', 0, 0)"
    ).run("src3", "listed", "https://dav.example");
    const app = makeApp(sqlite);
    const r = await app.get("/storage/sources/list");
    assert(r.status === 200, `200 (got ${r.status})`);
    const modeAttr = await xmlAttr(r, "mode");
    assert(modeAttr === "sync_only", `mode attr='sync_only' in XML (got '${modeAttr}')`);
  }

  // ---------------------------------------------------------------------------
  // asyncScanSource with mode='sync_only' → skips library inserts
  // ---------------------------------------------------------------------------
  console.log("\nasyncScanSource mode='sync_only' → skips library inserts:");
  {
    // Mock DB that tracks insert calls
    const state = {
      artistInserts: 0,
      albumInserts: 0,
      masterInserts: 0,
      instanceInserts: 0,
      sourceUpdates: 0,
      scanJobUpdates: 0,
    };

    function makeStmt(sql: string, binds: unknown[] = []): unknown {
      const trimmed = sql.trim().replace(/\s+/g, " ");
      const s = {
        bind(...args: unknown[]) { return makeStmt(sql, args); },
        async run() {
          if (trimmed.startsWith("INSERT INTO scan_jobs")) return { success: true };
          if (trimmed.startsWith("UPDATE scan_jobs")) { state.scanJobUpdates++; return { success: true }; }
          if (trimmed.startsWith("INSERT OR IGNORE INTO artists")) { state.artistInserts++; return { success: true }; }
          if (trimmed.startsWith("INSERT OR IGNORE INTO albums")) { state.albumInserts++; return { success: true }; }
          if (trimmed.startsWith("INSERT OR IGNORE INTO song_masters")) { state.masterInserts++; return { success: true }; }
          if (trimmed.startsWith("INSERT OR IGNORE INTO song_instances")) { state.instanceInserts++; return { success: true }; }
          if (trimmed.startsWith("UPDATE storage_sources SET last_sync")) { state.sourceUpdates++; return { success: true }; }
          if (trimmed.startsWith("UPDATE albums SET")) return { success: true };
          throw new Error(`unmocked run sql: ${trimmed.substring(0, 80)}`);
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          if (trimmed.startsWith("SELECT id, storage_uri, source_etag")) {
            return { results: [] }; // no existing instances
          }
          throw new Error(`unmocked all sql: ${trimmed.substring(0, 80)}`);
        },
        async first<T = unknown>(): Promise<T | null> { return null; },
      };
      void binds;
      return s;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockDb: any = {
      prepare(sql: string) { return makeStmt(sql); },
      async batch(stmts: unknown[]) {
        for (const stmt of stmts) {
          await (stmt as { run(): Promise<unknown> }).run();
        }
        return [];
      },
    };

    // Two audio files to scan (discovered via PROPFIND mock)
    const propfindXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/music/album/track01.mp3</href>
    <propstat><status>HTTP/1.1 200 OK</status>
      <prop><getcontenttype>audio/mpeg</getcontenttype><getcontentlength>12345</getcontentlength></prop>
    </propstat>
  </response>
  <response>
    <href>/music/album/track02.mp3</href>
    <propstat><status>HTTP/1.1 200 OK</status>
      <prop><getcontenttype>audio/mpeg</getcontenttype><getcontentlength>23456</getcontentlength></prop>
    </propstat>
  </response>
</multistatus>`;

    // Parse the multistatus to create DavEntry array — reuse the exported parser
    const entries = parseMultistatus(propfindXml, "");
    const audioFiles = entries.filter((e) => !e.isDir && e.path.endsWith(".mp3"));
    assert(audioFiles.length === 2, `parsed 2 audio entries (got ${audioFiles.length})`);

    // Run asyncScanSource with a mock that returns the above entries
    const srcSyncOnly = {
      id: "test-src",
      base_url: "https://dav.example",
      username: "user",
      password: "pass",
      password_encrypted: null,
      root_path: "",
      mode: "sync_only",
    };

    // Override listWebdav by patching fetch (asyncScanSource calls listWebdav internally)
    // We need to mock the WebDAV PROPFIND. The easiest approach: override global fetch.
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request, _init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("dav.example")) {
        return new Response(propfindXml, {
          status: 207,
          headers: { "Content-Type": "application/xml" },
        });
      }
      return originalFetch(url, _init);
    };

    try {
      await asyncScanSource(mockDb, srcSyncOnly, "job-sync-test");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }

    assert(state.artistInserts === 0, `0 artist inserts for sync_only (got ${state.artistInserts})`);
    assert(state.albumInserts === 0, `0 album inserts for sync_only (got ${state.albumInserts})`);
    assert(state.masterInserts === 0, `0 master inserts for sync_only (got ${state.masterInserts})`);
    assert(state.instanceInserts === 0, `0 instance inserts for sync_only (got ${state.instanceInserts})`);
    assert(state.sourceUpdates === 1, `last_sync updated (got ${state.sourceUpdates})`);
  }

  // ---------------------------------------------------------------------------
  // asyncScanSource with mode='library' → does insert
  // ---------------------------------------------------------------------------
  console.log("\nasyncScanSource mode='library' → inserts into library:");
  {
    const state = {
      masterInserts: 0,
      instanceInserts: 0,
      sourceUpdates: 0,
    };

    function makeStmt(sql: string, binds: unknown[] = []): unknown {
      const trimmed = sql.trim().replace(/\s+/g, " ");
      const s = {
        bind(...args: unknown[]) { return makeStmt(sql, args); },
        async run() {
          if (trimmed.startsWith("INSERT INTO scan_jobs")) return { success: true };
          if (trimmed.startsWith("UPDATE scan_jobs")) return { success: true };
          if (trimmed.startsWith("INSERT OR IGNORE INTO artists")) return { success: true };
          if (trimmed.startsWith("INSERT OR IGNORE INTO albums")) return { success: true };
          if (trimmed.startsWith("INSERT OR IGNORE INTO song_masters")) { state.masterInserts++; return { success: true }; }
          if (trimmed.startsWith("INSERT OR IGNORE INTO song_instances")) { state.instanceInserts++; return { success: true }; }
          if (trimmed.startsWith("UPDATE storage_sources SET last_sync")) { state.sourceUpdates++; return { success: true }; }
          if (trimmed.startsWith("UPDATE albums SET")) return { success: true };
          throw new Error(`unmocked run sql: ${trimmed.substring(0, 80)}`);
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          if (trimmed.startsWith("SELECT id, storage_uri, source_etag")) return { results: [] };
          throw new Error(`unmocked all sql: ${trimmed.substring(0, 80)}`);
        },
        async first<T = unknown>(): Promise<T | null> { return null; },
      };
      void binds;
      return s;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockDb: any = {
      prepare(sql: string) { return makeStmt(sql); },
      async batch(stmts: unknown[]) {
        for (const stmt of stmts) {
          await (stmt as { run(): Promise<unknown> }).run();
        }
        return [];
      },
    };

    const propfindXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/music/track01.flac</href>
    <propstat><status>HTTP/1.1 200 OK</status>
      <prop><getcontenttype>audio/flac</getcontenttype><getcontentlength>99999</getcontentlength></prop>
    </propstat>
  </response>
</multistatus>`;

    const srcLibrary = {
      id: "lib-src",
      base_url: "https://lib.dav.example",
      username: "user",
      password: "pass",
      password_encrypted: null,
      root_path: "",
      mode: "library",
    };

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request, _init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("lib.dav.example")) {
        return new Response(propfindXml, {
          status: 207,
          headers: { "Content-Type": "application/xml" },
        });
      }
      return originalFetch(url, _init);
    };

    try {
      await asyncScanSource(mockDb, srcLibrary, "job-lib-test");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }

    assert(state.masterInserts === 1, `1 master insert for library mode (got ${state.masterInserts})`);
    assert(state.instanceInserts === 1, `1 instance insert for library mode (got ${state.instanceInserts})`);
    assert(state.sourceUpdates === 1, `last_sync updated (got ${state.sourceUpdates})`);
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
