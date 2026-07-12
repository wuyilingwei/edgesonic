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

// Coverage for the clone "follow the upstream original path" chain:
//  1. originalPathToR2Key boundary cases (traversal segments, Windows drives,
//     Music/MUSIC root casing, control characters, over-long paths, <2 parts)
//  2. fallbackR2Key dedup — two distinct masters with identical synthesized
//     names must never share an R2 key, while re-runs stay idempotent
//  3. mapSong emits Child.path verbatim for r2:// storage URIs (music/ kept)
//  4. ingestAudio end-to-end: originalPath wins, fallback dedups, identity
//     map resolution keeps the key stable across a re-clone after an R2 wipe
//
// Run: npx tsx test/internal/clone_original_path.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { cloneRoutes, originalPathToR2Key, fallbackR2Key } from "../../worker/src/endpoints/edgesonic/clone";
import { mapSong } from "../../worker/src/types/subsonic";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// --------------------------------------------------------------------------
// 1. originalPathToR2Key boundaries
// --------------------------------------------------------------------------
console.log("originalPathToR2Key boundaries:");

assert(
  originalPathToR2Key("/app/media/music/Artist/Album/01 Song.flac") === "music/Artist/Album/01 Song.flac",
  "absolute unix path anchored at music root",
);
assert(
  originalPathToR2Key("C:\\Music\\Artist\\Album\\01 Song.flac") === "music/Artist/Album/01 Song.flac",
  "Windows drive + backslashes + capital Music root normalized to lowercase music/",
);
assert(
  originalPathToR2Key("MUSIC/Artist/x.mp3") === "music/Artist/x.mp3",
  "all-caps MUSIC root normalized to lowercase music/",
);
assert(
  originalPathToR2Key("Artist/Album/x.mp3") === "music/Artist/Album/x.mp3",
  "no music segment → music/ prepended",
);
assert(
  originalPathToR2Key("music/a/b/c/d.flac") === "music/a/b/c/d.flac",
  "arbitrary depth below music/ preserved",
);
assert(
  originalPathToR2Key("../../etc/passwd") === "music/etc/passwd",
  "traversal segments dropped, remainder re-rooted under music/",
);
{
  const key = originalPathToR2Key("music/Artist/../../../secret/x.mp3") || "";
  assert(
    key === "music/Artist/secret/x.mp3" && !key.split("/").includes(".."),
    `no standalone .. segment survives (got ${key})`,
  );
}
assert(
  originalPathToR2Key("music/Artist/./x.mp3") === "music/Artist/x.mp3",
  "single-dot segments dropped",
);
assert(
  originalPathToR2Key("music/Art\u0000ist/x\u001f.mp3") === "music/Artist/x.mp3",
  "control characters stripped from segments",
);
assert(originalPathToR2Key("x.mp3") === "music/x.mp3", "bare filename lands directly under music/");
assert(originalPathToR2Key("music") === null, "single music segment → null (fallback)");
assert(originalPathToR2Key("") === null, "empty → null");
assert(originalPathToR2Key("   ") === null, "whitespace-only → null");
assert(originalPathToR2Key("/././..") === null, "only dot segments → null");
{
  const long = "music/" + "很长的目录名".repeat(80) + "/x.flac"; // > 900 bytes UTF-8
  assert(originalPathToR2Key(long) === null, "over-long path (>900 bytes) → null (fallback)");
}
{
  // Round-trip of a library whose artist directory is literally "Music".
  const key = originalPathToR2Key("music/Music/Album/x.flac");
  assert(key === "music/Music/Album/x.flac", `nested Music dir kept, root stays canonical (got ${key})`);
}

// --------------------------------------------------------------------------
// 2. fallbackR2Key dedup
// --------------------------------------------------------------------------
console.log("fallbackR2Key dedup:");
{
  const a = fallbackR2Key("Artist", "Album", "Intro.flac", "sm-aaa");
  const b = fallbackR2Key("Artist", "Album", "Intro.flac", "sm-bbb");
  const a2 = fallbackR2Key("Artist", "Album", "Intro.flac", "sm-aaa");
  assert(a !== b, `distinct masters get distinct fallback keys (${a} vs ${b})`);
  assert(a === a2, "same master re-run hits the identical fallback key");
  assert(a.startsWith("music/Artist/Album/Intro.") && a.endsWith(".flac"), `hash sits before the extension (got ${a})`);
  const noExt = fallbackR2Key("Artist", "Album", "track", "sm-aaa");
  assert(/^music\/Artist\/Album\/track\.[0-9a-f]{8}$/.test(noExt), `extension-less filename still hashed (got ${noExt})`);
}

// --------------------------------------------------------------------------
// 3. mapSong Child.path from storage URIs
// --------------------------------------------------------------------------
console.log("mapSong Child.path emission:");
{
  const base = {
    id: "sm-1", album_id: "al-1", artist_id: "ar-1", album_artist_id: null,
    title: "T", sort_title: "t", track: 1, disc: 1, duration: 100, genre: null,
    compilation: 0, lyrics: null, created_at: 0, updated_at: 0,
  } as any;
  const r2 = mapSong({ ...base, inst_storage_uri: "r2://music/Artist/Album/x.flac" }, "al-1");
  assert(r2.path === "music/Artist/Album/x.flac", `r2 URI keeps full key incl. music/ (got ${r2.path})`);
  const deep = mapSong({ ...base, inst_storage_uri: "r2://music/a/b/c/d.flac" }, "al-1");
  assert(deep.path === "music/a/b/c/d.flac", `deep r2 key preserved (got ${deep.path})`);
  const dav = mapSong({ ...base, inst_storage_uri: "webdav://src1/a/b.flac" }, "al-1");
  assert(dav.path === "a/b.flac", `webdav URI still strips scheme+source id (got ${dav.path})`);
  const none = mapSong({ ...base, inst_storage_uri: null }, "al-1");
  assert(none.path === undefined, "no instance → no path");
  // Round-trip: what this instance advertises must map back to the same key
  // when another EdgeSonic clones us.
  const advertised = r2.path || "";
  assert(originalPathToR2Key(advertised) === "music/Artist/Album/x.flac", "advertised path round-trips to the identical R2 key");
  const nested = mapSong({ ...base, inst_storage_uri: "r2://music/Music/Album/x.flac" }, "al-1");
  assert(originalPathToR2Key(nested.path || "") === "music/Music/Album/x.flac", "nested Music dir round-trips unchanged");
}

// --------------------------------------------------------------------------
// 4. ingestAudio end-to-end (D1 + R2 mocks)
// --------------------------------------------------------------------------
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function makeBucket() {
  const map = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    map,
    bucket: {
      async put(key: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
        const data = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
        map.set(key, { data, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
        return { size: data.length };
      },
      async delete(key: string) { map.delete(key); },
    },
  };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      year INTEGER, genre TEXT, song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT,
      track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
      compilation INTEGER DEFAULT 0, lyrics TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL,
      source_id TEXT NOT NULL, source_type TEXT DEFAULT 'original',
      storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT,
      size INTEGER, tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );

    INSERT INTO users (username, master_password, level, enabled) VALUES ('admin', 'hash', 3, 1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_users', 1);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-1', 'Artist', 'artist');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-1', 'Album', 'album');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, duration)
      VALUES ('sm-one', 'al-1', 'ar-1', 'Intro', 'intro', 10);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, duration)
      VALUES ('sm-two', 'al-1', 'ar-1', 'Intro', 'intro', 200);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, bucket: any) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/edgesonic", cloneRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket };
  return {
    async ingest(params: Record<string, string>, bytes: string) {
      const qs = new URLSearchParams(params);
      return app.fetch(new Request(`http://test/edgesonic/clone/ingestAudio?${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "audio/flac" },
        body: new TextEncoder().encode(bytes),
      }), env as any);
    },
  };
}

async function main() {
  console.log("ingestAudio honours originalPath:");
  const sqlite = buildDb();
  const r2 = makeBucket();
  const app = makeApp(sqlite, r2.bucket);

  const withPath = await app.ingest({
    masterId: "sm-one", suffix: "flac", contentType: "audio/flac",
    artist: "Artist", album: "Album", filename: "Intro.flac",
    originalPath: "/srv/Music/Artist/Album/Intro.flac", size: "5",
  }, "AAAAA");
  const withPathBody = await withPath.json() as any;
  assert(withPath.status === 200 && withPathBody.ok === true, `ingest with originalPath ok (status ${withPath.status})`);
  assert(withPathBody.r2Key === "music/Artist/Album/Intro.flac", `capital Music root canonicalized (got ${withPathBody.r2Key})`);
  assert(r2.map.has("music/Artist/Album/Intro.flac"), "bytes stored under canonical key");

  console.log("ingestAudio fallback keys never collide across masters:");
  const fbOne = await app.ingest({
    masterId: "sm-one", suffix: "flac", contentType: "audio/flac",
    artist: "Artist", album: "Album", filename: "Intro.flac", size: "5",
  }, "ONE__");
  const fbOneBody = await fbOne.json() as any;
  const fbTwo = await app.ingest({
    masterId: "sm-two", suffix: "flac", contentType: "audio/flac",
    artist: "Artist", album: "Album", filename: "Intro.flac", size: "5",
  }, "TWO__");
  const fbTwoBody = await fbTwo.json() as any;
  assert(fbOneBody.ok === true && fbTwoBody.ok === true, "both fallback ingests ok");
  assert(fbOneBody.r2Key !== fbTwoBody.r2Key, `distinct masters → distinct keys (${fbOneBody.r2Key} vs ${fbTwoBody.r2Key})`);
  const oneBytes = new TextDecoder().decode(r2.map.get(fbOneBody.r2Key)?.data || new Uint8Array());
  const twoBytes = new TextDecoder().decode(r2.map.get(fbTwoBody.r2Key)?.data || new Uint8Array());
  assert(oneBytes === "ONE__" && twoBytes === "TWO__", "neither upload overwrote the other");

  console.log("re-clone after R2 wipe reuses the same key + instance row:");
  r2.map.clear();
  const again = await app.ingest({
    masterId: "sm-one", suffix: "flac", contentType: "audio/flac",
    artist: "Artist", album: "Album", filename: "Intro.flac",
    originalPath: "/srv/Music/Artist/Album/Intro.flac", size: "5",
  }, "AAAAA");
  const againBody = await again.json() as any;
  assert(againBody.ok === true && againBody.r2Key === "music/Artist/Album/Intro.flac", "same key after wipe");
  assert(againBody.registered === false, "existing instance row reused (idempotent)");
  const instCount = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM song_instances WHERE master_id='sm-one' AND storage_uri='r2://music/Artist/Album/Intro.flac'",
  ).get() as any;
  assert(instCount?.n === 1, `exactly one instance row for the path-derived key (got ${instCount?.n})`);
  assert(r2.map.has("music/Artist/Album/Intro.flac"), "bytes restored in R2");

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
