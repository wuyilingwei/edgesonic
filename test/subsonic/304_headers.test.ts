// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression test for the 302/304 hang chain described in task 265:
//  - A 304 response MUST NOT carry Content-Length / Content-Range / Content-
//    Type describing the body it doesn't have. Browsers reject or hang on
//    such 304s, which cascaded into fetchFullBlob never settling and the
//    background-download slot leaking under PLAYING_LIMIT=1.
//  - The cover-art 304 paths in media.ts had the same issue.
//
// Coverage:
//  1. /rest/download with a matching If-None-Match → 304 with NO body-
//     descriptor headers, only Cache-Control / ETag / Accept-Ranges.
//  2. /rest/getCoverArt (sized + legacy) with a matching If-None-Match → 304
//     with no Content-Length / Content-Type.
//
// Run: npx tsx test/subsonic/304_headers.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { downloadRoutes } from "../../worker/src/endpoints/subsonic/download";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";

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
  const store = new Map<string, { body: Uint8Array; contentType: string; etag?: string }>();
  const makeObject = (item: { body: Uint8Array; contentType: string; etag?: string }) => ({
    body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(item.body); c.close(); } }),
    httpMetadata: { contentType: item.contentType },
    httpEtag: item.etag ?? `"default-etag"`,
    size: item.body.length,
    writeHttpMetadata(headers: Headers) {
      if (item.contentType) headers.set("Content-Type", item.contentType);
    },
  });
  return {
    store,
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return makeObject(item);
    },
    async put() { /* no-op for tests */ },
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, cover_r2_key TEXT);
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
      source_type TEXT, parent_instance_id TEXT,
      expires_at INTEGER, last_accessed_at INTEGER,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      presign_username TEXT, presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      enabled INTEGER DEFAULT 1, mode TEXT NOT NULL DEFAULT 'library',
      cache_tier TEXT
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0, PRIMARY KEY (level, permission)
    );
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (1, 'download', 1), (1, 'stream', 1),
      (0, 'download', 0), (0, 'stream', 1);
    INSERT INTO artists (id, name) VALUES ('ar-1', 'Real Artist');
    INSERT INTO albums (id, name, cover_r2_key) VALUES ('al-1', 'Real Album', 'covers/al-1');
  `);
  return sqlite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync, bucket: any, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", downloadRoutes);
  app.route("/rest", mediaRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket, INSTANCE_ID: "test" };
  return {
    async get(url: string, init?: RequestInit) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${url}`, init), env as any);
    },
  };
}

async function main() {
  console.log("download 304 strips body-descriptor headers:");
  {
    const sqlite = buildDb();
    sqlite.prepare(
      "INSERT INTO song_masters (id, album_id, artist_id, title) VALUES (?, 'al-1', 'ar-1', ?)",
    ).run("sm-1", "Track One");
    sqlite.prepare(
      "INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, missing, updated_at) VALUES (?, ?, 'r2-local', ?, 'mp3', 'audio/mpeg', 12345, 0, 1700000000)",
    ).run("si-1", "sm-1", "r2://music/t1.mp3");
    const bucket = makeR2Bucket();
    bucket.store.set("music/t1.mp3", { body: new TextEncoder().encode("audio-bytes"), contentType: "audio/mpeg" });

    const etag = `"si-1-12345-1700000000"`;
    const { get } = makeApp(sqlite, bucket, { username: "u", level: 1 });
    const r = await get("/rest/download?id=sm-1", { headers: { "If-None-Match": etag } });
    assert(r.status === 304, `304 status (got ${r.status})`);
    assert(r.headers.get("Content-Length") === null, `no Content-Length on 304 (got ${r.headers.get("Content-Length")})`);
    assert(r.headers.get("Content-Range") === null, `no Content-Range on 304 (got ${r.headers.get("Content-Range")})`);
    assert(r.headers.get("Content-Type") === null, `no Content-Type on 304 (got ${r.headers.get("Content-Type")})`);
    assert(r.headers.get("ETag") === etag, `ETag preserved (got ${r.headers.get("ETag")})`);
    assert(r.headers.get("Cache-Control")?.includes("private"), `Cache-Control private (got ${r.headers.get("Cache-Control")})`);
    assert(r.headers.get("Accept-Ranges") === "bytes", `Accept-Ranges bytes (got ${r.headers.get("Accept-Ranges")})`);
  }

  console.log("\ngetCoverArt 304 (sized) strips body-descriptor headers:");
  {
    const sqlite = buildDb();
    const bucket = makeR2Bucket();
    // The sized-cover ETag is synthetic and stable per (cover, size, format):
    // no Accept header → jpeg → "covers/al-1_s128.jpg". A matching
    // If-None-Match short-circuits to 304 before any R2 read or transform.
    bucket.store.set("covers/al-1", { body: new TextEncoder().encode("jpeg-bytes"), contentType: "image/jpeg" });
    bucket.store.set("covers/al-1_s128.jpg", { body: new TextEncoder().encode("jpeg-bytes"), contentType: "image/jpeg" });
    const { get } = makeApp(sqlite, bucket, { username: "u", level: 1 });
    const r = await get("/rest/getCoverArt?id=al-1&size=128", { headers: { "If-None-Match": '"covers/al-1_s128.jpg"' } });
    assert(r.status === 304, `304 status (got ${r.status})`);
    assert(r.headers.get("Content-Length") === null, `no Content-Length on 304 (got ${r.headers.get("Content-Length")})`);
    assert(r.headers.get("Content-Type") === null, `no Content-Type on 304 (got ${r.headers.get("Content-Type")})`);
    assert(r.headers.get("Cache-Control")?.includes("private"), `Cache-Control private (got ${r.headers.get("Cache-Control")})`);
    assert(r.headers.get("Cache-Control")?.includes("immutable"), `Cache-Control immutable (got ${r.headers.get("Cache-Control")})`);
  }

  console.log("\ngetCoverArt 304 (legacy) strips body-descriptor headers:");
  {
    const sqlite = buildDb();
    const bucket = makeR2Bucket();
    bucket.store.set("covers/al-1", { body: new TextEncoder().encode("jpeg-bytes"), contentType: "image/jpeg", etag: '"cover-orig-etag"' });
    const { get } = makeApp(sqlite, bucket, { username: "u", level: 1 });
    const r = await get("/rest/getCoverArt?id=al-1", { headers: { "If-None-Match": '"cover-orig-etag"' } });
    assert(r.status === 304, `304 status (got ${r.status})`);
    assert(r.headers.get("Content-Length") === null, `no Content-Length on 304 (got ${r.headers.get("Content-Length")})`);
    assert(r.headers.get("Content-Type") === null, `no Content-Type on 304 (got ${r.headers.get("Content-Type")})`);
    assert(r.headers.get("Cache-Control")?.includes("private"), `Cache-Control private (got ${r.headers.get("Cache-Control")})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });