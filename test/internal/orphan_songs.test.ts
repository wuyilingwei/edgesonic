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
//  1. GET orphanSongs lists only masters parked under unknown-artist/
//     pending-uploads, aggregating instance_count/total_size/tag_scanned
//     (MAX)/missing (MAX) per master, ordered by created_at DESC — a real
//     (non-orphan) song is excluded.
//  2. POST orphanSongs/delete removes the R2 object(s), song_instances rows,
//     and the song_masters row for each given id; the shared unknown-artist/
//     pending-uploads placeholder rows themselves are left alone (reused by
//     future uploads).
//  3. A master with zero instances still deletes cleanly (no storage calls).
//  4. Missing masterIds body → 400, no mutation.
//  5. Non-admin (level 2) → 403 on both endpoints, no mutation.
//
// node:sqlite shim mirrors maintenance_reclaim.test.ts's harness; R2 mock
// mirrors cross_copy.test.ts's makeR2Bucket.
//
// Run: npx tsx test/internal/orphan_songs.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
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
  return {
    prepare,
    batch: async (s: unknown[]) =>
      Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())),
  };
}

function makeR2Bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async delete(key: string) { store.delete(key); },
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      title TEXT NOT NULL,
      duration INTEGER,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT DEFAULT 'original',
      storage_uri TEXT NOT NULL,
      suffix TEXT NOT NULL,
      content_type TEXT,
      size INTEGER,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (3, 'maintenance_cleanup', 1, 0),
      (2, 'maintenance_cleanup', 0, 0),
      (1, 'maintenance_cleanup', 0, 0),
      (0, 'maintenance_cleanup', 0, 0),
      (3, 'delete', 1, 0),
      (2, 'delete', 0, 0),
      (1, 'delete', 0, 0),
      (0, 'delete', 0, 0);
    INSERT INTO artists (id, name) VALUES ('unknown-artist', 'Unknown Artist');
    INSERT INTO albums (id, name) VALUES ('pending-uploads', 'Pending Uploads');
    INSERT INTO artists (id, name) VALUES ('artist-real', 'Real Artist');
    INSERT INTO albums (id, name) VALUES ('album-real', 'Real Album');
  `);
  return sqlite;
}

function seedMaster(
  sqlite: DatabaseSync,
  opts: { id: string; title: string; albumId: string; artistId: string; createdAt: number },
) {
  sqlite.prepare(
    "INSERT INTO song_masters (id, album_id, artist_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(opts.id, opts.albumId, opts.artistId, opts.title, opts.createdAt, opts.createdAt);
}

function seedInstance(
  sqlite: DatabaseSync,
  opts: { id: string; masterId: string; storageUri: string; suffix?: string; size?: number; tagScanned?: number; missing?: number },
) {
  sqlite.prepare(
    "INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, tag_scanned, missing, created_at, updated_at) VALUES (?, ?, 'r2-local', ?, ?, ?, ?, ?, 0, 0)",
  ).run(opts.id, opts.masterId, opts.storageUri, opts.suffix ?? "mp3", opts.size ?? 1000, opts.tagScanned ?? 0, opts.missing ?? 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync, bucket: any, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", maintenanceRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket };
  return {
    async get(url: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(new Request(`http://test${url}`), env as any);
    },
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

interface OrphanListBody {
  ok: boolean;
  songs?: Array<{
    masterId: string; title: string; createdAt: number; instanceCount: number;
    suffix: string | null; totalSize: number; tagScanned: number; missing: boolean;
  }>;
}
interface OrphanDeleteBody {
  ok: boolean;
  deleted?: number;
  failed?: number;
  error?: string;
  items?: Array<{ masterId: string; ok: boolean; error?: string }>;
}

async function main() {
  console.log("GET orphanSongs excludes real songs, aggregates per master:");
  {
    const sqlite = buildDb();
    // Real song — not orphan, must not appear.
    seedMaster(sqlite, { id: "sm-real", title: "Real Song", albumId: "album-real", artistId: "artist-real", createdAt: 100 });
    seedInstance(sqlite, { id: "si-real", masterId: "sm-real", storageUri: "r2://music/real.mp3" });

    // Orphan #1: single instance, never scanned.
    seedMaster(sqlite, { id: "sm-orphan1", title: "赤羽 我爱你2.0", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 200 });
    seedInstance(sqlite, { id: "si-o1", masterId: "sm-orphan1", storageUri: "r2://music/orphan1.mp3", size: 500, tagScanned: 0 });

    // Orphan #2: two instances — one scanned-empty (tag_scanned=2 → not modeled here,
    // use 1 to represent "scanned but stuck"), one missing — MAX() should surface both.
    seedMaster(sqlite, { id: "sm-orphan2", title: "Upload 2", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 300 });
    seedInstance(sqlite, { id: "si-o2a", masterId: "sm-orphan2", storageUri: "r2://music/orphan2a.mp3", size: 300, tagScanned: 1, missing: 0 });
    seedInstance(sqlite, { id: "si-o2b", masterId: "sm-orphan2", storageUri: "r2://music/orphan2b.mp3", size: 400, tagScanned: 1, missing: 1 });

    const { get } = makeApp(sqlite, makeR2Bucket(), { username: "admin", level: 3 });
    const r = await get("/edgesonic/maintenance/orphanSongs");
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as OrphanListBody;
    assert(body.ok === true, "ok:true");
    const songs = body.songs ?? [];
    assert(songs.length === 2, `2 orphan songs (got ${songs.length})`);
    assert(!songs.some((s) => s.masterId === "sm-real"), "real song excluded");
    // Ordered by created_at DESC — sm-orphan2 (300) before sm-orphan1 (200).
    assert(songs[0]?.masterId === "sm-orphan2", `newest first (got ${songs[0]?.masterId})`);

    const o1 = songs.find((s) => s.masterId === "sm-orphan1");
    assert(o1?.instanceCount === 1, `orphan1 instanceCount=1 (got ${o1?.instanceCount})`);
    assert(o1?.totalSize === 500, `orphan1 totalSize=500 (got ${o1?.totalSize})`);
    assert(o1?.tagScanned === 0, `orphan1 tagScanned=0 (got ${o1?.tagScanned})`);
    assert(o1?.missing === false, `orphan1 missing=false (got ${o1?.missing})`);

    const o2 = songs.find((s) => s.masterId === "sm-orphan2");
    assert(o2?.instanceCount === 2, `orphan2 instanceCount=2 (got ${o2?.instanceCount})`);
    assert(o2?.totalSize === 700, `orphan2 totalSize=700 (got ${o2?.totalSize})`);
    assert(o2?.missing === true, `orphan2 missing=true (MAX across instances, got ${o2?.missing})`);
  }

  console.log("\nPOST orphanSongs/delete removes storage + D1 rows, keeps placeholder buckets:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, { id: "sm-o1", title: "Orphan A", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 100 });
    seedInstance(sqlite, { id: "si-o1", masterId: "sm-o1", storageUri: "r2://music/o1.mp3" });
    seedMaster(sqlite, { id: "sm-o2", title: "Orphan B", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 200 });
    seedInstance(sqlite, { id: "si-o2", masterId: "sm-o2", storageUri: "r2://music/o2.mp3" });

    const bucket = makeR2Bucket();
    bucket.store.set("music/o1.mp3", new Uint8Array([1]));
    bucket.store.set("music/o2.mp3", new Uint8Array([2]));

    const { post } = makeApp(sqlite, bucket, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/orphanSongs/delete", { masterIds: ["sm-o1", "sm-o2"] });
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as OrphanDeleteBody;
    assert(body.ok === true && body.deleted === 2, `deleted=2 (got ${body.deleted})`);
    assert(body.failed === 0, `failed=0 (got ${body.failed})`);

    assert(!bucket.store.has("music/o1.mp3"), "R2 object o1 removed");
    assert(!bucket.store.has("music/o2.mp3"), "R2 object o2 removed");
    const masters = sqlite.prepare("SELECT id FROM song_masters WHERE id IN ('sm-o1','sm-o2')").all();
    assert(masters.length === 0, "both song_masters rows gone");
    const instances = sqlite.prepare("SELECT id FROM song_instances WHERE master_id IN ('sm-o1','sm-o2')").all();
    assert(instances.length === 0, "both song_instances rows gone");

    // Placeholder bucket rows themselves must survive — future uploads reuse them.
    const artist = sqlite.prepare("SELECT id FROM artists WHERE id='unknown-artist'").get();
    const album = sqlite.prepare("SELECT id FROM albums WHERE id='pending-uploads'").get();
    assert(!!artist, "unknown-artist placeholder row preserved");
    assert(!!album, "pending-uploads placeholder row preserved");
  }

  console.log("\nMaster with zero instances still deletes cleanly:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, { id: "sm-empty", title: "No Instances", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 100 });
    const { post } = makeApp(sqlite, makeR2Bucket(), { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/orphanSongs/delete", { masterIds: ["sm-empty"] });
    const body = await r.json() as OrphanDeleteBody;
    assert(body.deleted === 1, `deleted=1 (got ${body.deleted})`);
    const master = sqlite.prepare("SELECT id FROM song_masters WHERE id='sm-empty'").get();
    assert(!master, "empty-instance master removed");
  }

  console.log("\nMissing masterIds body → 400, no mutation:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, { id: "sm-untouched", title: "Untouched", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 100 });
    const { post } = makeApp(sqlite, makeR2Bucket(), { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/orphanSongs/delete", {});
    assert(r.status === 400, `400 (got ${r.status})`);
    const master = sqlite.prepare("SELECT id FROM song_masters WHERE id='sm-untouched'").get();
    assert(!!master, "row untouched on 400");
  }

  console.log("\nNon-admin (level 2) → 403 on both endpoints, no mutation:");
  {
    const sqlite = buildDb();
    seedMaster(sqlite, { id: "sm-guard", title: "Guarded", albumId: "pending-uploads", artistId: "unknown-artist", createdAt: 100 });
    seedInstance(sqlite, { id: "si-guard", masterId: "sm-guard", storageUri: "r2://music/guard.mp3" });
    const bucket = makeR2Bucket();
    bucket.store.set("music/guard.mp3", new Uint8Array([9]));

    const { get, post } = makeApp(sqlite, bucket, { username: "user", level: 2 });
    const listResp = await get("/edgesonic/maintenance/orphanSongs");
    assert(listResp.status === 403, `list 403 (got ${listResp.status})`);
    const delResp = await post("/edgesonic/maintenance/orphanSongs/delete", { masterIds: ["sm-guard"] });
    assert(delResp.status === 403, `delete 403 (got ${delResp.status})`);

    const master = sqlite.prepare("SELECT id FROM song_masters WHERE id='sm-guard'").get();
    assert(!!master, "master row untouched on 403");
    assert(bucket.store.has("music/guard.mp3"), "R2 object untouched on 403");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
