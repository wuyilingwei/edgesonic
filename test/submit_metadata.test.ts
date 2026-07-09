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
// Same shape as test/batch_write_tags.test.ts:
//   * In-memory SQLite shimmed as D1 + real metadataRoutes
//   * Hono harness injects a session-auth admin user so permissionMiddleware
//     for "edit_tags" / "manage_sources" sees the seeded permission rows.
//   * No R2 / no WebDAV — the endpoint never touches them anyway (041 is the
//     "browser parsed everything, just record it" path).
//
// Run: npx tsx test/submit_metadata.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { metadataRoutes } from "../worker/src/endpoints/tag/submit";

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
// Schema — subset that metadata.ts + permissionMiddleware touch.
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
      source_id TEXT,
      storage_uri TEXT NOT NULL,
      suffix TEXT,
      content_type TEXT,
      size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      sample_rate INTEGER,
      channels INTEGER,
      duration INTEGER,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );

    -- Seed: one admin with edit_tags + manage_sources (the latter for /findInstanceByUri).
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_tags', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'manage_sources', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-old', 'Old Artist');
    INSERT INTO albums (id, name) VALUES ('al-old', 'Old Album');

    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-old', 'ar-old', 'Song One', 1, 0);

    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size, tag_scanned)
      VALUES ('inst-1', 'sg-1', 'r2://music/foo.m4a', 'm4a', 'audio/mp4', 5000000, 0);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness with session-auth fake (bypasses Subsonic auth + esChain).
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", metadataRoutes);
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
      const req = new Request(`http://test${url}`);
      return app.fetch(req, env);
    },
  };
}

// ---------------------------------------------------------------------------
async function main() {

console.log("happy path: existing instance + full tags:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/submit", {
    instanceId: "inst-1",
    tags: {
      title: "Brand New Song",
      artist: "New Star",
      album: "Galaxy",
      genre: "electronic",
      year: 2026,
      track: 4,
      disc: 1,
      duration: 240,
      bitrate: 256,
      sampleRate: 44100,
      channels: 2,
      lyrics: "la la la",
      container: "MPEG 4",     // still diagnostic-only
      codec: "ALAC",           // ditto
    },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "body.ok true");
  assert(body.masterId === "sg-1", `masterId echoed (got ${body.masterId})`);
  assert(typeof body.artistId === "string" && body.artistId.startsWith("ar-"), "new artistId returned");
  assert(typeof body.albumId === "string" && body.albumId.startsWith("al-"), "new albumId returned");

  // D1: song_masters fields applied
  const sm = sqlite.prepare("SELECT * FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm.title === "Brand New Song", `title updated (got ${sm.title})`);
  assert(sm.track === 4, "track updated");
  assert(sm.disc === 1, "disc updated");
  assert(sm.genre === "electronic", "genre updated");
  assert(sm.duration === 240, "master duration updated");
  assert(sm.artist_id === body.artistId, "master.artist_id relinked");
  assert(sm.album_id === body.albumId, "master.album_id relinked");
  assert(sm.lyrics === "la la la", "109 — lyrics persisted alongside the logical relink");

  // D1: song_instances physical params + tag_scanned
  const si = sqlite.prepare("SELECT * FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, `tag_scanned=1 (got ${si.tag_scanned})`);
  assert(si.bit_rate === 256, `bit_rate (got ${si.bit_rate})`);
  assert(si.sample_rate === 44100, `sample_rate (got ${si.sample_rate})`);
  assert(si.channels === 2, `channels (got ${si.channels})`);
  assert(si.duration === 240, `instance duration (got ${si.duration})`);

  // D1: new artist/album rows + year/genre on album
  const ar = sqlite.prepare("SELECT name FROM artists WHERE id=?").get(body.artistId) as any;
  assert(ar?.name === "New Star", `artist row created (got ${ar?.name})`);
  const al = sqlite.prepare("SELECT name, year, genre FROM albums WHERE id=?").get(body.albumId) as any;
  assert(al?.name === "Galaxy", `album row created (got ${al?.name})`);
  assert(al?.year === 2026, `album year populated (got ${al?.year})`);
  assert(al?.genre === "electronic", `album genre populated (got ${al?.genre})`);

  // D1: empty-sweep removed the orphaned old artist/album rows.
  const oldAr = sqlite.prepare("SELECT * FROM artists WHERE id='ar-old'").get();
  const oldAl = sqlite.prepare("SELECT * FROM albums WHERE id='al-old'").get();
  assert(!oldAr, "old artist row swept (no songs left pointing at it)");
  assert(!oldAl, "old album row swept (no songs left pointing at it)");
}

console.log("relink: brand-new artist & album are auto-created:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/submit", {
    instanceId: "inst-1",
    tags: { artist: "Unique One", album: "Singleton" },
  });
  assert(r.status === 200, "200 status");
  const body = await r.json() as any;
  assert(body.ok === true, "ok");

  // Both rows exist and are wired to the song.
  const sm = sqlite.prepare("SELECT artist_id, album_id FROM song_masters WHERE id='sg-1'").get() as any;
  const ar = sqlite.prepare("SELECT name FROM artists WHERE id=?").get(sm.artist_id) as any;
  const al = sqlite.prepare("SELECT name FROM albums WHERE id=?").get(sm.album_id) as any;
  assert(ar?.name === "Unique One", "artist auto-created");
  assert(al?.name === "Singleton", "album auto-created");
}

console.log("unknown instanceId → 400:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/submit", {
    instanceId: "inst-ghost",
    tags: { title: "x", artist: "y" },
  });
  assert(r.status === 400, `400 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === false && /not found/i.test(body.error), `error mentions not found (got ${body.error})`);
}

console.log("missing body / missing tags → 400:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r1 = await post("/tag/submit", {});
  assert(r1.status === 400, `empty body → 400 (got ${r1.status})`);

  const r2 = await post("/tag/submit", { instanceId: "inst-1" });
  assert(r2.status === 400, `missing tags → 400 (got ${r2.status})`);

  // All whitespace + invalid numerics + NO lyrics → still "No usable tag fields"
  const r3 = await post("/tag/submit", {
    instanceId: "inst-1",
    tags: { title: "   ", artist: "", year: 0, track: -1 },
  });
  assert(r3.status === 400, `whitespace-only logical fields → 400 (got ${r3.status})`);
  const b3 = await r3.json() as any;
  assert(/no usable/i.test(b3.error), `error: "No usable tag fields" (got ${b3.error})`);

  // embedded LYRICS/USLT tag (no title/artist change) must not 400 either, or
  // the lyrics never reach applyMetadataResult at all.
  const r4 = await post("/tag/submit", {
    instanceId: "inst-1",
    tags: { title: "   ", artist: "", year: 0, track: -1, lyrics: "lyrics-only submission" },
  });
  assert(r4.status === 200, `lyrics-only submission → 200 (got ${r4.status})`);
  const sm4 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm4.lyrics === "lyrics-only submission", "109 — lyrics-only submission persists lyrics");
}

console.log("findInstanceByUri: exact uri match:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite);
  const r = await get("/tag/findInstanceByUri?uri=" + encodeURIComponent("r2://music/foo.m4a"));
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "ok");
  assert(body.instanceId === "inst-1", "instanceId");
  assert(body.masterId === "sg-1", "masterId");
  assert(body.suffix === "m4a", "suffix");
  assert(body.tagScanned === 0, "tagScanned reflects current DB state");
}

console.log("findInstanceByUri: missing uri → 400, unknown uri → 404:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite);
  const r1 = await get("/tag/findInstanceByUri");
  assert(r1.status === 400, `missing uri → 400 (got ${r1.status})`);

  const r2 = await get("/tag/findInstanceByUri?uri=" + encodeURIComponent("r2://music/ghost.m4a"));
  assert(r2.status === 404, `unknown uri → 404 (got ${r2.status})`);
}

console.log("partial patch only updates supplied fields:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  // title only → genre/track must stay as before
  const before = sqlite.prepare("SELECT track, genre, duration FROM song_masters WHERE id='sg-1'").get() as any;
  const r = await post("/tag/submit", {
    instanceId: "inst-1",
    tags: { title: "Renamed" },
  });
  assert(r.status === 200, "200 status");
  const sm = sqlite.prepare("SELECT title, track, genre, duration FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm.title === "Renamed", "title applied");
  assert(sm.track === before.track, "track preserved (COALESCE)");
  assert(sm.genre === before.genre, "genre preserved (COALESCE)");
  assert(sm.duration === before.duration, "duration preserved (COALESCE)");
  // instance physical params should be untouched but tag_scanned = 1
  const si = sqlite.prepare("SELECT bit_rate, sample_rate, channels, tag_scanned FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, "tag_scanned still flips to 1");
  assert(si.bit_rate === 0, "bit_rate untouched (no field in patch)");
  assert(si.sample_rate === null, "sample_rate untouched (no field in patch)");
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
