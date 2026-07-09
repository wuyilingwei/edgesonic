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
//   * Spin up an in-memory SQLite via Node's built-in node:sqlite.
//   * Wrap it in a minimal D1Database shim (prepare/bind/run/first/all) so the
//     production queries (createQueries) and endpoint handlers run unmodified.
//   * Drive each Hono route through annotationRoutes.fetch().
//
// Run: npx tsx test/annotation.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createQueries } from "../worker/src/db/queries";
import { annotationRoutes } from "../worker/src/endpoints/subsonic/annotation";

// ---------------------------------------------------------------------------
// Tiny test harness (same style as test/tagwrite.test.ts)
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// D1Database shim backed by node:sqlite
// ---------------------------------------------------------------------------
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) {
        boundArgs = args;
        return this;
      },
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
// Build the schema we need (subset of migrations 0001 + 0006)
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
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    -- 108 -- song listings LEFT JOIN the preferred instance for physical fields
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL DEFAULT '',
      suffix TEXT DEFAULT '', content_type TEXT, bit_rate INTEGER, size INTEGER,
      duration INTEGER, missing INTEGER DEFAULT 0
    );
    CREATE TABLE annotations (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
      play_count INTEGER DEFAULT 0,
      play_date INTEGER,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      starred INTEGER DEFAULT 0,
      starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
  `);

  // Seed: one user with edit_annotations + browse, plus a small library.
  sqlite.exec(`
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_annotations', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'browse', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO artists (id, name) VALUES ('ar-2', 'Artist Two');

    INSERT INTO albums (id, name, year, genre) VALUES ('al-1', 'First Album', 2001, 'Rock');
    INSERT INTO albums (id, name, year, genre) VALUES ('al-2', 'Second Album', 2020, 'Jazz');

    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, genre)
      VALUES ('sg-1', 'al-1', 'ar-1', 'Song A', 1, 180, 'Rock');
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, genre)
      VALUES ('sg-2', 'al-1', 'ar-1', 'Song B', 2, 200, 'Rock');
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, genre)
      VALUES ('sg-3', 'al-2', 'ar-2', 'Song C', 1, 240, 'Jazz');
  `);

  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness that injects user/authMethod into the context (skips real auth)
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, username = "alice") {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  // Inject the user before sub-routes' permissionMiddleware runs.
  app.use("*", async (c, next) => {
    c.set("user", { username, level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", annotationRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async hit(method: "GET" | "POST", url: string) {
      const req = new Request(`http://test${url}`, { method });
      return app.fetch(req, env);
    },
  };
}

function xmlHas(xml: string, fragment: string): boolean {
  return xml.includes(fragment);
}
function statusOK(xml: string): boolean {
  return xml.includes('status="ok"');
}
function statusFailed(xml: string): boolean {
  return xml.includes('status="failed"');
}

async function main() {
// ===========================================================================
// queries.ts unit tests (operate directly against the D1 shim)
// ===========================================================================
console.log("queries: starItem / unstarItem / setItemRating / scrobbleSong");
{
  const sqlite = buildDb();
  const q = createQueries(makeD1(sqlite));

  await q.starItem("alice", "sg-1", "song");
  let row = sqlite.prepare(
    "SELECT * FROM annotations WHERE user_id=? AND item_id=? AND item_type=?"
  ).get("alice", "sg-1", "song") as any;
  assert(row && row.starred === 1 && typeof row.starred_at === "number", "star song writes starred=1 + starred_at");

  await q.unstarItem("alice", "sg-1", "song");
  row = sqlite.prepare(
    "SELECT * FROM annotations WHERE user_id=? AND item_id=? AND item_type=?"
  ).get("alice", "sg-1", "song") as any;
  assert(row && row.starred === 0 && row.starred_at === null, "unstar clears starred + starred_at");

  await q.setItemRating("alice", "al-1", "album", 4);
  row = sqlite.prepare(
    "SELECT rating FROM annotations WHERE user_id=? AND item_id=? AND item_type=?"
  ).get("alice", "al-1", "album") as any;
  assert(row && row.rating === 4, "setRating 4 persists");

  await q.setItemRating("alice", "al-1", "album", 0);
  row = sqlite.prepare(
    "SELECT rating FROM annotations WHERE user_id=? AND item_id=? AND item_type=?"
  ).get("alice", "al-1", "album") as any;
  assert(row && row.rating === null, "setRating 0 clears to NULL");

  const t = Math.floor(Date.now() / 1000);
  await q.scrobbleSong("alice", "sg-2", t);
  await q.scrobbleSong("alice", "sg-2", t + 10);
  row = sqlite.prepare(
    "SELECT play_count, play_date FROM annotations WHERE user_id=? AND item_id=? AND item_type=?"
  ).get("alice", "sg-2", "song") as any;
  assert(row && row.play_count === 2, `scrobble x2 → play_count=${row?.play_count}`);
  assert(row && row.play_date === t + 10, "scrobble updates play_date to latest");
}

console.log("queries: getStarred*");
{
  const sqlite = buildDb();
  const q = createQueries(makeD1(sqlite));
  await q.starItem("alice", "ar-1", "artist");
  await q.starItem("alice", "al-1", "album");
  await q.starItem("alice", "sg-3", "song");

  const artists = await q.getStarredArtists("alice");
  const albums = await q.getStarredAlbums("alice");
  const songs = await q.getStarredSongs("alice");
  assert(artists.length === 1 && artists[0].id === "ar-1", "starred artists fetched");
  assert(albums.length === 1 && albums[0].id === "al-1", "starred albums fetched");
  assert(albums[0].artist_name === "Artist One", "starred album joined artist_name");
  assert(songs.length === 1 && songs[0].id === "sg-3", "starred songs fetched");
  assert(songs[0].album_name === "Second Album", "starred song joined album_name");
}

console.log("queries: getRandomSongs");
{
  const sqlite = buildDb();
  const q = createQueries(makeD1(sqlite));

  const all = await q.getRandomSongs({ size: 10 });
  assert(all.length === 3, `default returns all 3 songs (got ${all.length})`);

  const rock = await q.getRandomSongs({ size: 10, genre: "Rock" });
  assert(rock.length === 2 && rock.every((s) => s.genre === "Rock"), "genre=Rock filters");

  const old = await q.getRandomSongs({ size: 10, toYear: 2010 });
  assert(old.length === 2 && old.every((s) => s.album_id === "al-1"), "toYear filters via albums.year");

  const small = await q.getRandomSongs({ size: 1 });
  assert(small.length === 1, "size limit honoured");
}

// ===========================================================================
// Endpoint smoke tests (through annotationRoutes via Hono fetch)
// ===========================================================================
console.log("endpoint: star / unstar / setRating / scrobble");
{
  const sqlite = buildDb();
  const { hit } = makeApp(sqlite);

  const r1 = await hit("GET", "/rest/star?id=sg-1");
  const body1 = await r1.text();
  assert(r1.status === 200 && statusOK(body1), "GET /rest/star happy path");

  const row1 = sqlite.prepare(
    "SELECT starred FROM annotations WHERE user_id='alice' AND item_id='sg-1' AND item_type='song'"
  ).get() as any;
  assert(row1 && row1.starred === 1, "star endpoint wrote starred=1");

  const r2 = await hit("GET", "/rest/star.view?albumId=al-1&artistId=ar-1");
  assert(r2.status === 200 && statusOK(await r2.text()), ".view suffix accepted");
  const rowAlbum = sqlite.prepare(
    "SELECT starred FROM annotations WHERE item_id='al-1' AND item_type='album'"
  ).get() as any;
  const rowArtist = sqlite.prepare(
    "SELECT starred FROM annotations WHERE item_id='ar-1' AND item_type='artist'"
  ).get() as any;
  assert(rowAlbum?.starred === 1 && rowArtist?.starred === 1, "albumId & artistId both starred");

  const rUnstar = await hit("GET", "/rest/unstar?id=sg-1");
  assert(statusOK(await rUnstar.text()), "unstar endpoint OK");
  const row2 = sqlite.prepare(
    "SELECT starred, starred_at FROM annotations WHERE item_id='sg-1' AND item_type='song'"
  ).get() as any;
  assert(row2 && row2.starred === 0 && row2.starred_at === null, "unstar cleared row");

  const rRate = await hit("GET", "/rest/setRating?id=al-1&rating=5");
  assert(statusOK(await rRate.text()), "setRating 5 OK");
  const ratingRow = sqlite.prepare(
    "SELECT rating, item_type FROM annotations WHERE item_id='al-1' AND item_type='album'"
  ).get() as any;
  assert(ratingRow && ratingRow.rating === 5, "setRating 5 persisted as album");

  const rRate0 = await hit("GET", "/rest/setRating?id=al-1&rating=0");
  assert(statusOK(await rRate0.text()), "setRating 0 OK");
  const cleared = sqlite.prepare(
    "SELECT rating FROM annotations WHERE item_id='al-1' AND item_type='album'"
  ).get() as any;
  assert(cleared && cleared.rating === null, "setRating 0 cleared rating to NULL");

  const rScrob = await hit("GET", "/rest/scrobble?id=sg-2");
  assert(statusOK(await rScrob.text()), "scrobble OK");
  const playRow = sqlite.prepare(
    "SELECT play_count FROM annotations WHERE item_id='sg-2' AND item_type='song'"
  ).get() as any;
  assert(playRow && playRow.play_count === 1, "scrobble incremented play_count");

  const rScrob2 = await hit("GET", "/rest/scrobble?id=sg-2&submission=false");
  assert(statusOK(await rScrob2.text()), "scrobble submission=false ack");
  const playRow2 = sqlite.prepare(
    "SELECT play_count FROM annotations WHERE item_id='sg-2' AND item_type='song'"
  ).get() as any;
  assert(playRow2 && playRow2.play_count === 1, "submission=false did NOT increment play_count");
}

console.log("endpoint: getStarred / getStarred2 / getRandomSongs");
{
  const sqlite = buildDb();
  const { hit } = makeApp(sqlite);

  await hit("GET", "/rest/star?id=sg-1");
  await hit("GET", "/rest/star?albumId=al-2");
  await hit("GET", "/rest/star?artistId=ar-2");

  const rs1 = await hit("GET", "/rest/getStarred");
  const body1 = await rs1.text();
  assert(statusOK(body1), "getStarred OK status");
  assert(xmlHas(body1, "<starred>") && xmlHas(body1, "</starred>"), "<starred> wrapper");
  assert(xmlHas(body1, 'id="ar-2"'), "starred artist serialised");
  assert(xmlHas(body1, 'id="al-2"'), "starred album serialised");
  assert(xmlHas(body1, 'id="sg-1"'), "starred song serialised");

  const rs2 = await hit("GET", "/rest/getStarred2.view");
  const body2 = await rs2.text();
  assert(statusOK(body2), "getStarred2.view OK");
  assert(xmlHas(body2, "<starred2>"), "<starred2> wrapper for getStarred2");

  const rRand = await hit("GET", "/rest/getRandomSongs?size=3");
  const bodyRand = await rRand.text();
  assert(statusOK(bodyRand), "getRandomSongs OK");
  const songCount = (bodyRand.match(/<song /g) ?? []).length;
  assert(songCount === 3, `getRandomSongs returned 3 songs (got ${songCount})`);

  const rGenre = await hit("GET", "/rest/getRandomSongs?size=10&genre=Jazz");
  const bodyGenre = await rGenre.text();
  const jazz = (bodyGenre.match(/<song /g) ?? []).length;
  assert(jazz === 1, `genre=Jazz filter → 1 song (got ${jazz})`);

  const rYear = await hit("GET", "/rest/getRandomSongs?size=10&toYear=2010");
  const bodyYear = await rYear.text();
  const oldSongs = (bodyYear.match(/<song /g) ?? []).length;
  assert(oldSongs === 2, `toYear=2010 → 2 songs from al-1 (got ${oldSongs})`);
}

console.log("endpoint: error paths");
{
  const sqlite = buildDb();
  const { hit } = makeApp(sqlite);

  const rNoId = await hit("GET", "/rest/star");
  const txt1 = await rNoId.text();
  assert(rNoId.status === 400 && statusFailed(txt1), "star without id returns 400 failed");
  assert(xmlHas(txt1, 'code="10"'), "Subsonic error code 10 (missing param)");

  const rBadRating = await hit("GET", "/rest/setRating?id=sg-1&rating=99");
  assert(rBadRating.status === 400 && statusFailed(await rBadRating.text()), "setRating 99 rejected");

  const rNoRating = await hit("GET", "/rest/setRating?id=sg-1");
  assert(rNoRating.status === 400 && statusFailed(await rNoRating.text()), "setRating missing rating rejected");

  const rNoScrob = await hit("GET", "/rest/scrobble");
  assert(rNoScrob.status === 400 && statusFailed(await rNoScrob.text()), "scrobble without id rejected");
}

console.log("endpoint: permission gating");
{
  const sqlite = buildDb();
  // Level 0 (guest) has no edit_annotations
  sqlite.exec(`INSERT INTO user_permissions VALUES (0, 'edit_annotations', 0, 0);`);
  sqlite.exec(`INSERT INTO user_permissions VALUES (0, 'browse', 1, 0);`);
  sqlite.exec(`INSERT INTO users (username, master_password, level) VALUES ('bob', 'x', 0);`);

  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "bob", level: 0, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", annotationRoutes);
  const env = { DB: makeD1(sqlite) };

  const r = await app.fetch(new Request("http://test/rest/star?id=sg-1"), env);
  assert(r.status === 403, `guest blocked from star (got ${r.status})`);

  const r2 = await app.fetch(new Request("http://test/rest/getRandomSongs"), env);
  assert(r2.status === 200, "guest allowed for getRandomSongs (browse permission)");
}

// ---------------------------------------------------------------------------
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
