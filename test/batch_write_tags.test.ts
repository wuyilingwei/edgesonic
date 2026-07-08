// Tests for task 039 — POST /rest/batchWriteTags.
//
// Strategy (same shape as test/annotation.test.ts):
//   * In-memory SQLite shimmed as D1, real createQueries + real handlers.
//   * Stubbed Env (no R2 / no WebDAV) → every instance write returns
//     `written:false reason:"format not rewritable"` because the seeded
//     instances use suffix=mp3 BUT have no real backing storage. We assert
//     on D1 effects (artist/album relink + song_masters.title) instead.
//   * Hono harness injects a session-auth user so permissionMiddleware
//     ("edit_tags") sees the seeded permission row.
//
// Run: npx tsx test/batch_write_tags.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tagEditRoutes } from "../worker/src/endpoints/tag/write";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1Database shim backed by node:sqlite
// ---------------------------------------------------------------------------
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
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

// ---------------------------------------------------------------------------
// Schema (subset: what tagedit + queries touch)
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
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
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      image_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      year INTEGER,
      genre TEXT,
      cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      album_artist_id TEXT,
      title TEXT NOT NULL,
      sort_title TEXT,
      track INTEGER,
      disc INTEGER,
      duration INTEGER,
      genre TEXT,
      compilation INTEGER DEFAULT 0,
      participants TEXT,
      lyrics TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT NOT NULL,
      storage_uri TEXT NOT NULL,
      suffix TEXT,
      content_type TEXT,
      size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY,
      base_url TEXT,
      username TEXT,
      password TEXT,
      presign_username TEXT,
      presign_password TEXT,
      root_path TEXT,
      enabled INTEGER DEFAULT 1
    );

    -- Seed: one admin with edit_tags + a small library, instances point at a
    -- bogus 'unknown://' uri so rewriteInstance falls into the read-only branch
    -- and reports written:false without ever touching env.MUSIC_BUCKET.
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_tags', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-old', 'Old Artist');
    INSERT INTO albums (id, name) VALUES ('al-old', 'Old Album');

    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-old', 'ar-old', 'Song One', 1, 180);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-2', 'al-old', 'ar-old', 'Song Two', 2, 200);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-3', 'al-old', 'ar-old', 'Song Three', 3, 220);

    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size)
      VALUES ('inst-1', 'sg-1', 'unknown://foo/1.mp3', 'mp3', 'audio/mpeg', 1000);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size)
      VALUES ('inst-2', 'sg-2', 'unknown://foo/2.mp3', 'mp3', 'audio/mpeg', 1000);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size)
      VALUES ('inst-3', 'sg-3', 'unknown://foo/3.mp3', 'mp3', 'audio/mpeg', 1000);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness injecting session auth (skips real Subsonic auth)
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", tagEditRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: undefined };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
  };
}

// ---------------------------------------------------------------------------
async function main() {
console.log("happy path: 3 ids, single field patch:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/batchWrite", { ids: ["sg-1", "sg-2", "sg-3"], patch: { artist: "New Star" } });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "body.ok true");
  assert(body.succeeded === 3 && body.failed === 0, `succeeded=3 failed=0 (got ${body.succeeded}/${body.failed})`);
  assert(Array.isArray(body.results) && body.results.length === 3, "3 result rows");
  assert(body.results.every((r: any) => r.ok === true), "every result row ok");

  // each row's first file entry should report written:false with the read-only
  // reason — instances use unknown:// uri, so rewriteInstance bails out fast.
  const fileEntries = body.results.flatMap((r: any) => r.files || []);
  assert(fileEntries.length === 3, `3 file entries collected (got ${fileEntries.length})`);
  assert(fileEntries.every((f: any) => f.written === false), "every file entry written:false (read-only branch)");

  // D1 effect: all 3 song_masters should now point at the same new artist row
  const rows = sqlite.prepare("SELECT id, artist_id, title FROM song_masters ORDER BY id").all() as any[];
  const newArtistIds = new Set(rows.map((r) => r.artist_id));
  assert(newArtistIds.size === 1, `all 3 songs share the new artist row (got ${newArtistIds.size} distinct)`);
  assert(!newArtistIds.has("ar-old"), "the old artist row no longer wins");
  const newArtist = sqlite.prepare("SELECT name FROM artists WHERE id = ?").get([...newArtistIds][0]) as any;
  assert(newArtist?.name === "New Star", `new artist name written (got ${newArtist?.name})`);

  // patch only contained `artist` — title MUST be untouched
  assert(rows.find((r) => r.id === "sg-1").title === "Song One", "title unchanged when patch omits it");
  assert(rows.find((r) => r.id === "sg-2").title === "Song Two", "title unchanged for sg-2");
  assert(rows.find((r) => r.id === "sg-3").title === "Song Three", "title unchanged for sg-3");
}

console.log("partial failure: one missing id + two valid ids:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/batchWrite", { ids: ["sg-1", "sg-ghost", "sg-3"], patch: { album: "Reissue" } });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.succeeded === 2 && body.failed === 1, `2 ok / 1 fail (got ${body.succeeded}/${body.failed})`);
  const ghost = body.results.find((x: any) => x.id === "sg-ghost");
  assert(ghost && ghost.ok === false && /not found/i.test(ghost.error), `ghost reports not found (got ${ghost?.error})`);

  // the two valid ids still moved to a new album
  const sg1 = sqlite.prepare("SELECT album_id FROM song_masters WHERE id='sg-1'").get() as any;
  const sg3 = sqlite.prepare("SELECT album_id FROM song_masters WHERE id='sg-3'").get() as any;
  assert(sg1.album_id !== "al-old" && sg1.album_id === sg3.album_id, "sg-1 + sg-3 moved to a shared new album");
}

console.log("validation errors:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);

  // empty ids
  const r1 = await post("/tag/batchWrite", { ids: [], patch: { artist: "X" } });
  assert(r1.status === 400, `empty ids → 400 (got ${r1.status})`);
  const b1 = await r1.json() as any;
  assert(/empty/i.test(b1.error), `empty ids error text (got ${b1.error})`);

  // > 50 ids
  const tooMany = Array.from({ length: 51 }, (_, i) => `sg-${i}`);
  const r2 = await post("/tag/batchWrite", { ids: tooMany, patch: { artist: "X" } });
  assert(r2.status === 400, `>50 ids → 400 (got ${r2.status})`);
  const b2 = await r2.json() as any;
  assert(/limit/i.test(b2.error), `cap mentioned in error (got ${b2.error})`);

  // no recognised patch fields
  const r3 = await post("/tag/batchWrite", { ids: ["sg-1"], patch: { artist: "   " } });
  assert(r3.status === 400, `empty trimmed patch → 400 (got ${r3.status})`);

  // missing patch entirely
  const r4 = await post("/tag/batchWrite", { ids: ["sg-1"] });
  assert(r4.status === 400, `missing patch → 400 (got ${r4.status})`);
}

console.log("patch with only artist leaves other fields:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);

  const before = sqlite.prepare("SELECT title, track, genre FROM song_masters WHERE id='sg-2'").get() as any;

  const r = await post("/tag/batchWrite", { ids: ["sg-2"], patch: { artist: "Solo" } });
  assert(r.status === 200, "200 status");
  const body = await r.json() as any;
  assert(body.succeeded === 1, "one success");

  const after = sqlite.prepare("SELECT title, track, genre FROM song_masters WHERE id='sg-2'").get() as any;
  assert(after.title === before.title, "title preserved (patch did not touch it)");
  assert(after.track === before.track, "track preserved");
  // genre starts NULL and COALESCE keeps it NULL when patch omits it
  assert(after.genre === before.genre, "genre preserved");

  // and album row was NOT created with the original 'Old Album' name —
  // patch only touched artist, the album row gets re-anchored under the new
  // artist key but album NAME stays as before (queries.ts seeds it from the
  // existing album.name COALESCE branch).
  const albumName = sqlite.prepare(
    "SELECT a.name FROM song_masters m JOIN albums a ON a.id = m.album_id WHERE m.id='sg-2'"
  ).get() as any;
  assert(albumName?.name === "Old Album", `album name preserved (got ${albumName?.name})`);
}

console.log("single writeTags still works after refactor:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/write", { id: "sg-1", tags: { title: "Renamed" } });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "single writeTags ok");
  assert(typeof body.masterId === "string" && typeof body.albumId === "string", "single writeTags echoes ids");
  const row = sqlite.prepare("SELECT title FROM song_masters WHERE id='sg-1'").get() as any;
  assert(row.title === "Renamed", `title updated (got ${row.title})`);
}

// ---------------------------------------------------------------------------
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => { console.error(err); process.exit(1); },
);
