//
// Regression test for a pre-existing bug surfaced by wiring up the first
// real UI entry point to /rest/download (Library.vue's SongRowMenu "⋮"
// menu): downloadHandler looked up the given `id` via
// queries.getSongInstance() (keyed on song_instances.id, 'si-' prefix), but
// every Subsonic client — including our own frontend — passes the *song*
// id, which throughout this codebase is song_masters.id ('sm-' prefix, see
// getSong/star/createShare/stream). The instance lookup by master id always
// missed, so every download 404'd with a generic "File not found" XML
// instead of streaming the file — for both R2 ("internal") and WebDAV
// ("external") backed songs, since the bug is upstream of the storage
// scheme switch.
//
// Coverage:
//  1. Download by master id (r2 scheme) → 200, correct body/Content-Type/
//     Content-Disposition (uses the real title, not the raw id)/Content-Length.
//  2. Download by a raw instance id ('si-' prefix) still works (tolerance
//     path, mirrors streamHandler's same convention).
//  3. A master whose only instance is missing=1 → 404 (getSongInstances
//     filters missing=0, same as stream/media.ts).
//  4. Unknown id entirely → 404.
//  5. Missing id query param → 400.
//  6. Download by master id (webdav scheme) → 200, body comes from the
//     stubbed upstream fetch with Basic auth.
//  7. No 'download' permission (level 0) → 403, XML body.
//
// node:sqlite shim mirrors maintenance_reclaim.test.ts / orphan_songs.test.ts;
// global fetch stub mirrors lastfm_proxy.test.ts's installFetchStub pattern.
//
// Run: npx tsx test/subsonic/download_song.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { downloadRoutes } from "../../worker/src/endpoints/subsonic/download";

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

function makeR2Bucket() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    store,
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(item.body); c.close(); } }),
        httpMetadata: { contentType: item.contentType },
      };
    },
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      title TEXT NOT NULL, track INTEGER, disc INTEGER, duration INTEGER,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT NOT NULL,
      storage_uri TEXT NOT NULL, suffix TEXT NOT NULL, content_type TEXT,
      bit_rate INTEGER, size INTEGER, duration INTEGER,
      missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      presign_username TEXT, presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      enabled INTEGER DEFAULT 1, mode TEXT NOT NULL DEFAULT 'library'
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0, PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (1, 'download', 1), (0, 'download', 0);
    INSERT INTO artists (id, name) VALUES ('ar-1', 'Real Artist');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Real Album');
  `);
  return sqlite;
}

function seedMaster(sqlite: DatabaseSync, id: string, title: string) {
  sqlite.prepare(
    "INSERT INTO song_masters (id, album_id, artist_id, title) VALUES (?, 'al-1', 'ar-1', ?)",
  ).run(id, title);
}
function seedInstance(
  sqlite: DatabaseSync,
  opts: { id: string; masterId: string; storageUri: string; suffix?: string; contentType?: string; size?: number; missing?: number },
) {
  sqlite.prepare(
    "INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, missing) VALUES (?, ?, 'r2-local', ?, ?, ?, ?, ?)",
  ).run(opts.id, opts.masterId, opts.storageUri, opts.suffix ?? "mp3", opts.contentType ?? "audio/mpeg", opts.size ?? 12345, opts.missing ?? 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync, bucket: any, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/rest", downloadRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket };
  return {
    async get(url: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${url}`), env as any);
    },
  };
}

// ---------------------------------------------------------------------------
// global fetch stub (webdav case only)
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; auth: string | null }> = [];
function installFetchStub(respond: () => Response) {
  fetchCalls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init?.headers);
    fetchCalls.push({ url, auth: headers.get("Authorization") });
    return respond();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

async function main() {
  console.log("Download by master id (r2 scheme) → 200, real title, correct headers:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, "sm-song1", "赤羽 我爱你2.0");
    seedInstance(sqlite, { id: "si-song1", masterId: "sm-song1", storageUri: "r2://music/song1.mp3" });
    const bucket = makeR2Bucket();
    bucket.store.set("music/song1.mp3", { body: new TextEncoder().encode("audio-bytes"), contentType: "audio/mpeg" });

    const { get } = makeApp(sqlite, bucket, { username: "u", level: 1 });
    const r = await get("/rest/download?id=sm-song1");
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("Content-Type") === "audio/mpeg", `Content-Type audio/mpeg (got ${r.headers.get("Content-Type")})`);
    const disposition = r.headers.get("Content-Disposition") || "";
    assert(disposition.includes(encodeURIComponent("赤羽 我爱你2.0.mp3")), `Content-Disposition uses real title (got ${disposition})`);
    const text = await r.text();
    assert(text === "audio-bytes", `body streamed through (got "${text}")`);
  }

  console.log("\nDownload by a raw instance id ('si-' prefix) still works:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, "sm-song2", "Track Two");
    seedInstance(sqlite, { id: "si-song2", masterId: "sm-song2", storageUri: "r2://music/song2.mp3" });
    const bucket = makeR2Bucket();
    bucket.store.set("music/song2.mp3", { body: new TextEncoder().encode("bytes2"), contentType: "audio/mpeg" });

    const { get } = makeApp(sqlite, bucket, { username: "u", level: 1 });
    const r = await get("/rest/download?id=si-song2");
    assert(r.status === 200, `200 for raw instance id (got ${r.status})`);
    assert((await r.text()) === "bytes2", "body matches for instance-id path");
  }

  console.log("\nMaster whose only instance is missing=1 → 404:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, "sm-gone", "Ghost Track");
    seedInstance(sqlite, { id: "si-gone", masterId: "sm-gone", storageUri: "r2://music/gone.mp3", missing: 1 });
    const { get } = makeApp(sqlite, makeR2Bucket(), { username: "u", level: 1 });
    const r = await get("/rest/download?id=sm-gone");
    assert(r.status === 404, `404 (got ${r.status})`);
    const text = await r.text();
    assert(/File not found/.test(text), `XML mentions File not found (got "${text.slice(0, 120)}")`);
  }

  console.log("\nUnknown id entirely → 404:");
  {
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, makeR2Bucket(), { username: "u", level: 1 });
    const r = await get("/rest/download?id=sm-does-not-exist");
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  console.log("\nMissing id query param → 400:");
  {
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, makeR2Bucket(), { username: "u", level: 1 });
    const r = await get("/rest/download");
    assert(r.status === 400, `400 (got ${r.status})`);
  }

  console.log("\nDownload by master id (webdav scheme) → 200, body from stubbed upstream fetch:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, "sm-wd1", "WebDAV Track");
    seedInstance(sqlite, { id: "si-wd1", masterId: "sm-wd1", storageUri: "webdav://wd-src/music/wd1.flac", suffix: "flac", contentType: "audio/flac" });
    sqlite.prepare(
      "INSERT INTO storage_sources (id, type, base_url, username, password, enabled) VALUES ('wd-src', 'webdav', 'https://dav.example.com/music', 'bob', 'secret', 1)",
    ).run();

    installFetchStub(() => new Response("webdav-bytes", { status: 200 }));
    try {
      const { get } = makeApp(sqlite, makeR2Bucket(), { username: "u", level: 1 });
      const r = await get("/rest/download?id=sm-wd1");
      assert(r.status === 200, `200 (got ${r.status})`);
      assert((await r.text()) === "webdav-bytes", "body comes from stubbed webdav fetch");
      assert(fetchCalls.length === 1 && fetchCalls[0].url.includes("music/wd1.flac"), `fetched the right URL (got ${fetchCalls[0]?.url})`);
      assert(fetchCalls[0].auth?.startsWith("Basic "), "sent Basic auth header");
    } finally {
      restoreFetch();
    }
  }

  console.log("\nNo 'download' permission (level 0) → 403:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, "sm-guard", "Guarded Track");
    seedInstance(sqlite, { id: "si-guard", masterId: "sm-guard", storageUri: "r2://music/guard.mp3" });
    const { get } = makeApp(sqlite, makeR2Bucket(), { username: "guest", level: 0 });
    const r = await get("/rest/download?id=sm-guard");
    assert(r.status === 403, `403 (got ${r.status})`);
    const text = await r.text();
    assert(/Not authorized/.test(text), `XML mentions Not authorized (got "${text.slice(0, 120)}")`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
