//
// Coverage:
//   1. presign_username set → presign URL uses presign_username:presign_password (not main creds)
//   2. presign_username null → presign URL falls back to main username:password
//   3. presign_username empty string → treated as null, falls back to main creds
//   4. getWebDAVPresignCredentials: sourceId not found → null
//   5. getWebDAVPresignCredentials: sourceId found, presign_username empty → returns main creds
//   6. sources/add with presign creds → D1 row stores presign_username + presign_password
//   7. sources/update clears presign creds (empty string) → presign_username/password become null
//   8. sources/list returns presignUsername attr (not password)
//   9. sources/list: source with no presign creds → presignUsername="" in response
//
// Run: npx tsx test/webdav_presign_creds.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createWebDAVAdapter } from "../worker/src/adapters/webdav";
import { getWebDAVPresignCredentials } from "../worker/src/adapters/index";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (s: any[]) => Promise.all(s.map((x: any) => x.run())) };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      password_encrypted TEXT, presign_username TEXT, presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER, enabled INTEGER DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions VALUES (3, 'manage_sources', 1, 0);

    -- 121 — /sources/list joins this for the per-source fileCount/sizeBytes
    -- footprint; empty is fine, the query just needs the table to exist.
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, source_id TEXT, size INTEGER DEFAULT 0,
      missing INTEGER DEFAULT 0
    );

    INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, enabled)
      VALUES ('wd-1', 'webdav', 'My NAS', 'https://nas.example.com/dav', 'nasuser', 'naspass', 'music', 1);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const { sourcesRoutes } = require("../worker/src/endpoints/storage/sources");
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", sourcesRoutes);
  const env: any = { DB: makeD1(sqlite), INSTANCE_ID: "test" };
  return { env, app };
}

async function main() {
  // ─── 1. presign_username set → URL uses presign creds ────────────────────
  console.log("presign: presign_username set → URL uses presign_username:presign_password");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "UPDATE storage_sources SET presign_username = 'rouser', presign_password = 'ropass' WHERE id = 'wd-1'"
    ).run();
    const adapter = createWebDAVAdapter(makeD1(sqlite), {});
    const result = await adapter.presign("webdav://wd-1/music/album/track.flac");
    assert(result !== null, "presign returns a URL");
    assert(result!.url.includes("rouser:ropass@"), "URL has presign creds: " + result!.url);
    assert(!result!.url.includes("nasuser"), "URL does NOT have main username");
    assert(!result!.url.includes("naspass"), "URL does NOT have main password");
  }

  // ─── 2. presign_username null → fallback to main creds ───────────────────
  console.log("\npresign: presign_username null → fallback to main username:password");
  {
    const sqlite = buildDb();
    // presign_username is NULL by default in buildDb
    const adapter = createWebDAVAdapter(makeD1(sqlite), {});
    const result = await adapter.presign("webdav://wd-1/music/album/track.flac");
    assert(result !== null, "presign returns a URL");
    assert(result!.url.includes("nasuser:naspass@"), "URL has main creds (fallback): " + result!.url);
  }

  // ─── 3. presign_username empty string → same as null, fallback ───────────
  console.log("\npresign: presign_username '' → treated as null, falls back to main creds");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "UPDATE storage_sources SET presign_username = '', presign_password = 'ropass' WHERE id = 'wd-1'"
    ).run();
    const adapter = createWebDAVAdapter(makeD1(sqlite), {});
    const result = await adapter.presign("webdav://wd-1/music/album/track.flac");
    assert(result !== null, "presign returns a URL");
    assert(result!.url.includes("nasuser:naspass@"), "URL falls back to main creds: " + result!.url);
    assert(!result!.url.includes("ropass"), "URL does NOT use presign_password when username empty");
  }

  // ─── 4. getWebDAVPresignCredentials: sourceId not found → null ───────────
  console.log("\ngetWebDAVPresignCredentials: sourceId not found → null");
  {
    const sqlite = buildDb();
    const creds = await getWebDAVPresignCredentials(makeD1(sqlite), "nonexistent-id");
    assert(creds === null, "returns null for missing sourceId");
  }

  // ─── 5. getWebDAVPresignCredentials: presign_username empty → main creds ─
  console.log("\ngetWebDAVPresignCredentials: presign_username empty → returns main creds");
  {
    const sqlite = buildDb();
    const creds = await getWebDAVPresignCredentials(makeD1(sqlite), "wd-1");
    assert(creds !== null, "returns creds object");
    assert(creds!.username === "nasuser", `username is main: ${creds!.username}`);
    assert(creds!.password === "naspass", `password is main: ${creds!.password}`);
    assert(creds!.baseUrl.includes("nas.example.com"), `baseUrl correct: ${creds!.baseUrl}`);
  }

  // ─── 6. sources/add with presign creds → DB row has presign fields ────────
  console.log("\nsources/add: with presign creds → D1 stores presign_username + presign_password");
  {
    const sqlite = buildDb();
    const { app, env } = makeApp(sqlite);
    const req = new Request("http://test/storage/sources/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "webdav", base_url: "https://dav.example.com", name: "Test DAV",
        username: "mainuser", password: "mainpass",
        presign_username: "readuser", presign_password: "readpass",
        root_path: "/media",
      }),
    });
    const resp = await app.fetch(req, env);
    assert(resp.status === 200, `add returns 200 (got ${resp.status})`);
    const row = sqlite.prepare(
      "SELECT presign_username, presign_password FROM storage_sources WHERE base_url = 'https://dav.example.com'"
    ).get() as { presign_username: string | null; presign_password: string | null } | null;
    assert(row !== null, "row inserted");
    assert(row!.presign_username === "readuser", `presign_username stored: ${row!.presign_username}`);
    assert(row!.presign_password === "readpass", `presign_password stored: ${row!.presign_password}`);
  }

  // ─── 7. sources/update clears presign creds → DB becomes null ────────────
  console.log("\nsources/update: clear presign creds (empty string) → presign_username/password become null");
  {
    const sqlite = buildDb();
    // First set them
    sqlite.prepare(
      "UPDATE storage_sources SET presign_username = 'rouser', presign_password = 'ropass' WHERE id = 'wd-1'"
    ).run();
    const { app, env } = makeApp(sqlite);
    const req = new Request("http://test/storage/sources/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "wd-1", presign_username: "", presign_password: "" }),
    });
    const resp = await app.fetch(req, env);
    assert(resp.status === 200, `update returns 200 (got ${resp.status})`);
    const row = sqlite.prepare(
      "SELECT presign_username, presign_password FROM storage_sources WHERE id = 'wd-1'"
    ).get() as { presign_username: string | null; presign_password: string | null } | null;
    assert(row !== null, "row found after update");
    assert(row!.presign_username === null, `presign_username nulled: ${JSON.stringify(row!.presign_username)}`);
    assert(row!.presign_password === null, `presign_password nulled: ${JSON.stringify(row!.presign_password)}`);
  }

  // ─── 8. sources/list returns presignUsername attr (not password) ──────────
  console.log("\nsources/list: returns presignUsername attr, NOT presign_password");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "UPDATE storage_sources SET presign_username = 'rouser', presign_password = 'supersecret' WHERE id = 'wd-1'"
    ).run();
    const { app, env } = makeApp(sqlite);
    const req = new Request("http://test/storage/sources/list");
    const resp = await app.fetch(req, env);
    assert(resp.status === 200, `list returns 200 (got ${resp.status})`);
    const body = await resp.text();
    assert(body.includes('presignUsername="rouser"'), "presignUsername attr present: " + body.substring(0, 200));
    assert(!body.includes("supersecret"), "presign_password NOT exposed in list response");
  }

  // ─── 9. sources/list: no presign creds → presignUsername="" ──────────────
  console.log("\nsources/list: source with no presign creds → presignUsername=\"\"");
  {
    const sqlite = buildDb();
    // presign_username is NULL by default
    const { app, env } = makeApp(sqlite);
    const req = new Request("http://test/storage/sources/list");
    const resp = await app.fetch(req, env);
    const body = await resp.text();
    assert(body.includes('presignUsername=""'), `presignUsername empty for null: ${body.substring(0, 300)}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
