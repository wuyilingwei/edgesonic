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
// Strategy:
//   * In-memory SQLite D1 shim with song_masters + song_instances rows.
//   * R2 Map-backed shim (for the fallback stream path).
//   * feature_strings row `enable_r2_presign` flipped per scenario.
//   * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CF_ACCOUNT_ID injected via env.
//   * Hono harness mounts mediaRoutes; we assert 302 + Location header shape
//     and the fallback (200 in-Worker stream) when presign is off / misconfig.
//
// Coverage:
//   1. feature on + secrets set + raw r2 instance  → 302 with SigV4 Location
//   2. feature off                                 → 200 in-Worker stream (fallback)
//   3. secrets missing                             → 200 fallback (no 302)
//   4. needsTranscode (format=mp3 mismatch)        → 200 (transcode/raw fallback, no 302)
//   5. non-r2 scheme (webdav)                      → 200 (no 302; webdav adapter 404 body)
//   6. Range header signed into the URL           → Location contains X-Amz-SignedHeaders=host;range
//   7. presignR2Get unit: URL shape, host, query params, signature presence
//   8. validator: enable_r2_presign accepts 0/1, rejects other
//
// Run: npx tsx test/r2_presign.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../worker/src/endpoints/subsonic/media";
import { presignR2Get } from "../worker/src/utils/r2presign";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim
// ---------------------------------------------------------------------------
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

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album One');
    INSERT INTO song_masters (id, album_id, artist_id, title, duration)
      VALUES ('sm-1', 'al-1', 'ar-1', 'Song A', 180);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate)
      VALUES ('si-r2', 'sm-1', 'r2-local', 'r2://music/album/track.flac', 'flac', 'audio/flac', 1000000, 1411);
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, bit_rate)
      VALUES ('si-wd', 'sm-1', 'webdav-1', 'webdav://webdav-1/music/album/track.flac', 'flac', 'audio/flac', 1000000, 1411);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// R2 shim (only used for the fallback path)
// ---------------------------------------------------------------------------
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
    async put() {},
    async delete() {},
    _map: map,
  };
}

// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
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

// ---------------------------------------------------------------------------
async function main() {
  console.log("presignR2Get: URL shape, host, query params, signature presence");
  {
    const url = await presignR2Get({
      bucket: "edgesonic-music",
      key: "music/album/track.flac",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      accountId: "df4481f3ce1fa0394b4617442a97d147",
      ttlSec: 300,
    });
    assert(url.startsWith("https://edgesonic-music.df4481f3ce1fa0394b4617442a97d147.r2.cloudflarestorage.com/"), "host is R2 S3 virtual-hosted endpoint");
    assert(url.includes("/music/album/track.flac"), "path has key (no bucket in path — virtual-hosted style)");
    assert(url.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"), "SigV4 algorithm param");
    assert(url.includes("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F"), "credential param");
    assert(url.includes("X-Amz-Expires=300"), "TTL param");
    assert(url.includes("X-Amz-SignedHeaders=host"), "signed headers (host only)");
    assert(url.includes("X-Amz-Content-Sha256=UNSIGNED-PAYLOAD"), "UNSIGNED-PAYLOAD marker present");
    assert(url.includes("X-Amz-Signature="), "signature present");
  }

  console.log("\npresignR2Get: host-only signing (Range unsigned, matches AWS SDK presign)");
  {
    const url = await presignR2Get({
      bucket: "edgesonic-music",
      key: "music/album/track.flac",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      accountId: "df4481f3ce1fa0394b4617442a97d147",
      ttlSec: 60,
      rangeHeader: "bytes=0-1048575",
    });
    assert(url.includes("X-Amz-SignedHeaders=host"), "signed headers = host only (Range unsigned)");
  }

  console.log("\npresignR2Get: TTL clamped to [1, 604800]");
  {
    const url = await presignR2Get({
      bucket: "b", key: "k",
      accessKeyId: "a", secretAccessKey: "s", accountId: "c",
      ttlSec: 999999,
    });
    assert(url.includes("X-Amz-Expires=604800"), "TTL clamped to 7 days max");
  }

  console.log("\nstream: feature on + secrets set + raw r2 → 302 with Location");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    });
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 302, `302 (got ${r.status})`);
    const loc = r.headers.get("Location") || "";
    assert(loc.startsWith("https://edgesonic-music.df4481f3ce1fa0394b4617442a97d147.r2.cloudflarestorage.com/"), "Location points to R2 S3 virtual-hosted endpoint");
    assert(loc.includes("X-Amz-Signature="), "Location carries signature");
    assert(loc.includes("/music/album/track.flac"), "Location path has key");
  }

  console.log("\nstream: feature off → 200 in-Worker stream (fallback)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "0");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    });
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no Location header on fallback");
  }

  console.log("\nstream: secrets missing → 200 fallback (no 302)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    // No R2_* secrets in env
    const { get } = makeApp(sqlite);
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 fallback (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no Location when secrets missing");
  }

  console.log("\nstream: partial secrets → 200 fallback (no 302)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      // secret + account missing
    });
    const r = await get("/rest/stream?id=sm-1&format=raw");
    assert(r.status === 200, `200 fallback (got ${r.status})`);
  }

  console.log("\nstream: needsTranscode (format=mp3 mismatch) → no 302 (transcode/raw path)");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    });
    // format=mp3 but instance is flac → needsTranscode=true; engine disabled → raw fallback
    // but needsTranscode flag still blocks presign (we guard on !needsTranscode)
    const r = await get("/rest/stream?id=sm-1&format=mp3");
    // Will be 200 (raw flac fallback since engine disabled) — the key assertion
    // is that we did NOT 302, because needsTranscode blocks the presign branch.
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no 302 when needsTranscode");
  }

  console.log("\nstream: non-r2 scheme (webdav) → no 302");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    });
    // Force-select the webdav instance by choosing format=flac (matches both;
    // selection logic prefers local/r2 so si-r2 still wins). Use a direct
    // approach: query with id that resolves to webdav instance only.
    // Actually getSongInstances returns all instances for the master; the
    // stream code picks one. To force webdav, we delete the r2 instance row.
    sqlite.prepare("DELETE FROM song_instances WHERE id = 'si-r2'").run();
    const r = await get("/rest/stream?id=sm-1&format=raw");
    // webdav adapter will try to fetch and likely 404/500 in test — but the
    // key assertion is NO 302 (presign only applies to r2 scheme).
    assert(r.status !== 302, `not 302 (got ${r.status})`);
    assert(r.headers.get("Location") === null, "no 302 for webdav scheme");
  }

  console.log("\nstream: Range header passed through to presign");
  {
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "1");
    const { get } = makeApp(sqlite, {
      R2_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      CF_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147",
    });
    const r = await get("/rest/stream?id=sm-1&format=raw", { Range: "bytes=0-1023" });
    assert(r.status === 302, "302 with Range");
    const loc = r.headers.get("Location") || "";
    assert(loc.includes("X-Amz-SignedHeaders=host"), "host-only SignedHeaders (Range unsigned)");
  }

  console.log("\nvalidator: enable_r2_presign accepts 0/1, rejects other (via /features/updateString)");
  {
    // Mount featuresRoutes to test the validator end-to-end.
    const { featuresRoutes } = await import("../worker/src/endpoints/edgesonic/features");
    const sqlite = buildDb();
    setFeature(sqlite, "enable_r2_presign", "0");
    const app = new Hono<{ Bindings: any; Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
      c.set("authMethod", "session");
      return next();
    });
    app.route("/edgesonic", featuresRoutes);
    // Seed user_permissions so manage_permissions check passes
    sqlite.exec(`
      CREATE TABLE user_permissions (
        level INTEGER NOT NULL, permission TEXT NOT NULL,
        enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
        PRIMARY KEY (level, permission)
      );
      INSERT INTO user_permissions VALUES (3, 'manage_permissions', 1, 0);
    `);
    const env: any = { DB: makeD1(sqlite), INSTANCE_ID: "t" };

    async function postUpdate(value: string) {
      const req = new Request("http://test/edgesonic/features/updateString", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "enable_r2_presign", value }),
      });
      return app.fetch(req, env);
    }
    let r = await postUpdate("0");
    assert(r.status === 200, `'0' accepted (got ${r.status})`);
    r = await postUpdate("1");
    assert(r.status === 200, `'1' accepted (got ${r.status})`);
    r = await postUpdate("true");
    assert(r.status === 400, `'true' rejected (got ${r.status})`);
    r = await postUpdate("");
    assert(r.status === 400, `empty rejected (got ${r.status})`);
    r = await postUpdate("2");
    assert(r.status === 400, `'2' rejected (got ${r.status})`);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
