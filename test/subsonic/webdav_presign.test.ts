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
// Coverage:
//  1. WebDAV presign URL shape (UserInfo embedded, path encoded)
//  2. WebDAV presign returns null when source has no credentials
//  3. stream: webdav + flag on + strategy=always/webdav_only → 302
//  4. stream: webdav + flag on + strategy=never/r2_only → 200 proxy
//  5. stream: webdav + flag off → 200 proxy
//  6. stream: r2 + strategy=never → 200 proxy (even with secrets)
//  7. stream: r2 + strategy=r2_only → 302 (r2 allowed)
//  8. stream: r2 + strategy=webdav_only → 200 proxy (r2 not allowed)
//  9. credentials/create accepts streamProxyStrategy
//  10. credentials/update changes streamProxyStrategy
//  11. credentials/list returns streamProxyStrategy
//  12. validator: enable_webdav_presign accepts 0/1
//
// Run: npx tsx test/subsonic/webdav_presign.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";
import { createWebDAVAdapter } from "../../worker/src/adapters/webdav";

// hit the real network. Returns a 200 with dummy bytes + Range support.
const origFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url && url.includes("nas.example.com")) {
      return new Response("WEBDAV_PROXY_BYTES", {
        status: 200,
        headers: {
          "Content-Type": "audio/flac",
          "Content-Length": "17",
          "Accept-Ranges": "bytes",
        },
      });
    }
    return origFetch(input as any, _init);
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = origFetch;
}

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
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT,
      track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
      compilation INTEGER DEFAULT 0, participants TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT,
      storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT,
      size INTEGER, bit_rate INTEGER, duration INTEGER,
      tag_scanned INTEGER DEFAULT 0, source_etag TEXT, source_last_modified TEXT,
      parent_instance_id TEXT, transcode_profile TEXT,
      source_type TEXT, missing INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      year INTEGER, genre TEXT, cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      image_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      description TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE features (
      key TEXT PRIMARY KEY, value INTEGER NOT NULL,
      description TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT, name TEXT, base_url TEXT,
      username TEXT, password TEXT, password_encrypted TEXT,
      presign_username TEXT, presign_password TEXT,
      root_path TEXT, enabled INTEGER DEFAULT 1, mode TEXT
    );

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album One');
    INSERT INTO song_masters (id, album_id, artist_id, title, duration)
      VALUES ('sm-1', 'al-1', 'ar-1', 'Song A', 180);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate)
      VALUES ('si-r2', 'sm-1', 'r2-local', 'r2://music/album/track.flac', 'flac', 'audio/flac', 1000000, 1411);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate)
      VALUES ('si-wd', 'sm-1', 'webdav-1', 'webdav://webdav-1/music/album/track.flac', 'flac', 'audio/flac', 1000000, 1411);

    INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, enabled)
      VALUES ('webdav-1', 'webdav', 'My NAS', 'https://nas.example.com/dav', 'nasuser', 'naspass', 'music', 1);
  `);
  return sqlite;
}

function makeR2() {
  const map = new Map<string, { data: Uint8Array; contentType: string }>();
  map.set("music/album/track.flac", {
    data: new TextEncoder().encode("FLAC_AUDIO_BYTES"),
    contentType: "audio/flac",
  });
  return {
    async get(key: string, _opts?: any) {
      const v = map.get(key);
      if (!v) return null;
      return {
        get body() {
          return new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(v.data); c.close(); },
          });
        },
        writeHttpMetadata(h: Headers) { h.set("Content-Type", v.contentType); },
        size: v.data.length,
        httpMetadata: { contentType: v.contentType },
      };
    },
    async put() {}, async delete() {},
  };
}

function makeApp(sqlite: DatabaseSync, envOverrides: Partial<Env> = {}, strategy: string = "always") {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    // block cross-origin redirects with embedded user:password). Tests that
    // assert 302 use subsonic_cred; tests that need session behavior override
    // this explicitly.
    c.set("authMethod", "subsonic_cred");
    c.set("streamProxyStrategy", strategy);
    return next();
  });
  app.route("/rest", mediaRoutes);
  const env: any = {
    DB: makeD1(sqlite),
    MUSIC_BUCKET: makeR2(),
    INSTANCE_ID: "test-instance",
    ...envOverrides,
  };
  return {
    env,
    async get(url: string, extraHeaders: Record<string, string> = {}) {
      const req = new Request(`http://test${url}`, { headers: new Headers(extraHeaders) });
      return app.fetch(req, env);
    },
  };
}

function setFeature(sqlite: DatabaseSync, key: string, value: string) {
  sqlite.prepare(
    "INSERT INTO feature_strings (key, value, description, updated_at) VALUES (?, ?, '', unixepoch()) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value);
}

async function main() {
  installFetchStub();
  console.log("WebDAV presign: URL shape (UserInfo embedded)");
  {
    const sqlite = buildDb();
    const adapter = createWebDAVAdapter(makeD1(sqlite), {});
    const result = await adapter.presign("webdav://webdav-1/music/album/track.flac");
    assert(result !== null, "presign returns a URL");
    // root_path='music' is appended to baseUrl by getSourceCredentials, so
    // the URL is https://user:pass@nas.example.com/dav/music/music/album/track.flac
    assert(result!.url.startsWith("https://nasuser:naspass@nas.example.com/dav/music/"), "URL has UserInfo + host: " + result!.url);
    assert(result!.url.includes("album/track.flac"), "URL has object path");
  }

  console.log("\nWebDAV presign: returns null when source not configured");
  {
    const sqlite = buildDb();
    sqlite.prepare("DELETE FROM storage_sources WHERE id = 'webdav-1'").run();
    const adapter = createWebDAVAdapter(makeD1(sqlite), {});
    const result = await adapter.presign("webdav://webdav-1/music/album/track.flac");
    assert(result === null, "null when no credentials");
  }

  console.log("\nstream: webdav + flag on + strategy=always → 302");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "1");
    // Delete r2 instance so webdav is selected
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const { get } = makeApp(sqlite, {}, "always");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 302, `302 (got ${r.status})`);
    const loc = r.headers.get("Location") || "";
    assert(loc.startsWith("https://nasuser:naspass@"), "Location has UserInfo");
  }

  console.log("\nstream: webdav + flag on + strategy=webdav_only → 302");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "1");
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const { get } = makeApp(sqlite, {}, "webdav_only");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 302, `302 (got ${r.status})`);
  }

  console.log("\nstream: webdav + flag on + strategy=never → 200 proxy");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "1");
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const { get } = makeApp(sqlite, {}, "never");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 proxy (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no Location on proxy");
  }

  console.log("\nstream: webdav + flag on + strategy=always + session auth → 200 proxy (CORS blocks UserInfo redirect)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "1");
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    // Override makeApp's default subsonic_cred with session (browser SPA case).
    // Browsers block cross-origin redirects with embedded user:password
    // webdav presign must fall back to in-Worker stream for sessions.
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
      c.set("authMethod", "session");
      c.set("streamProxyStrategy", "always");
      return next();
    });
    app.route("/rest", mediaRoutes);
    const env: any = {
      DB: makeD1(sqlite),
      MUSIC_BUCKET: makeR2(),
      INSTANCE_ID: "t",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };
    const r = await app.request("/rest/stream?id=sm-1&format=raw", {}, env);
    assert(r.status === 200, `200 proxy (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no Location — session must not get UserInfo redirect");
  }

  console.log("\nstream: webdav + flag on + strategy=r2_only → 200 proxy");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "1");
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const { get } = makeApp(sqlite, {}, "r2_only");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 proxy (got ${r.status})`);
  }

  console.log("\nstream: webdav + flag off → 200 proxy (regardless of strategy)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "0");
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const { get } = makeApp(sqlite, {}, "always");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 proxy (got ${r.status})`);
  }

  console.log("\nstream: r2 + strategy=never → 200 proxy (even with secrets)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    }, "never");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 proxy (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no Location when strategy=never");
  }

  console.log("\nstream: r2 + strategy=r2_only → 302");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    }, "r2_only");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 302, `302 (got ${r.status})`);
  }

  console.log("\nstream: r2 + strategy=webdav_only → 200 proxy (r2 not allowed)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    }, "webdav_only");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 proxy (got ${r.status})`);
  }

  console.log("\nstream: r2 + strategy=always → 302 (091 regression, still works)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    }, "always");
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 302, `302 (got ${r.status})`);
  }

  console.log("\ncredentials: create with streamProxyStrategy + list returns it");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      CREATE TABLE subsonic_credentials (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL,
        label TEXT DEFAULT '', last_used INTEGER,
        stream_proxy_strategy TEXT NOT NULL DEFAULT 'always',
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE user_permissions (
        level INTEGER NOT NULL, permission TEXT NOT NULL,
        enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
        PRIMARY KEY (level, permission)
      );
      INSERT INTO user_permissions VALUES (2, 'manage_credentials', 1, 0);
      INSERT INTO user_permissions VALUES (2, 'manage_permissions', 1, 0);
    `);
    const { featuresRoutes } = await import("../../worker/src/endpoints/edgesonic/features");
    const { edgesonicAuthRoutes } = await import("../../worker/src/endpoints/edgesonic/auth");
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
      c.set("authMethod", "session");
      return next();
    });
    app.route("/edgesonic", edgesonicAuthRoutes);
    app.route("/edgesonic", featuresRoutes);
    const env: any = { DB: makeD1(sqlite), INSTANCE_ID: "t" };

    // Create with strategy=never
    const createReq = new Request("http://test/edgesonic/auth/credentials/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secretpass", label: "Old Client", streamProxyStrategy: "never" }),
    });
    const createResp = await app.fetch(createReq, env);
    assert(createResp.status === 200, `create returns 200 (got ${createResp.status})`);
    const createText = await createResp.text();
    assert(createText.includes('streamProxyStrategy="never"'), "create response carries strategy");

    // List returns strategy
    const listReq = new Request("http://test/edgesonic/auth/credentials/list");
    const listResp = await app.fetch(listReq, env);
    const listText = await listResp.text();
    assert(listText.includes('streamProxyStrategy="never"'), "list returns strategy=never");

    // Extract the credential id
    const idMatch = listText.match(/id="([^"]+)"/);
    assert(idMatch !== null, "credential id extracted");
    const credId = idMatch![1];

    // Update strategy to r2_only
    const updateReq = new Request("http://test/edgesonic/auth/credentials/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: credId, label: "Old Client", streamProxyStrategy: "r2_only" }),
    });
    const updateResp = await app.fetch(updateReq, env);
    assert(updateResp.status === 200, `update returns 200 (got ${updateResp.status})`);
    const updateText = await updateResp.text();
    assert(updateText.includes('streamProxyStrategy="r2_only"'), "update response carries new strategy");

    // List again — strategy should be r2_only now
    const listReq2 = new Request("http://test/edgesonic/auth/credentials/list");
    const listResp2 = await app.fetch(listReq2, env);
    const listText2 = await listResp2.text();
    assert(listText2.includes('streamProxyStrategy="r2_only"'), "list reflects updated strategy");
    assert(!listText2.includes('streamProxyStrategy="never"'), "old strategy gone");
  }

  console.log("\nvalidator: enable_webdav_presign accepts 0/1, rejects other");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_webdav_presign", "0");
    sqlite.exec(`
      CREATE TABLE user_permissions (
        level INTEGER NOT NULL, permission TEXT NOT NULL,
        enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
        PRIMARY KEY (level, permission)
      );
      INSERT INTO user_permissions VALUES (3, 'manage_permissions', 1, 0);
    `);
    const { featuresRoutes } = await import("../../worker/src/endpoints/edgesonic/features");
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
      c.set("authMethod", "session");
      return next();
    });
    app.route("/edgesonic", featuresRoutes);
    const env: any = { DB: makeD1(sqlite), INSTANCE_ID: "t" };

    async function postUpdate(value: string) {
      const req = new Request("http://test/edgesonic/features/updateString", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "enable_webdav_presign", value }),
      });
      return app.fetch(req, env);
    }
    let r = await postUpdate("0");
    assert(r.status === 200, `'0' accepted (got ${r.status})`);
    r = await postUpdate("1");
    assert(r.status === 200, `'1' accepted (got ${r.status})`);
    r = await postUpdate("yes");
    assert(r.status === 400, `'yes' rejected (got ${r.status})`);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    restoreFetch();
    process.exit(1);
  } else {
    console.log("\nALL PASS");
    restoreFetch();
  }
}

main().catch((e) => { console.error(e); restoreFetch(); process.exit(1); });
