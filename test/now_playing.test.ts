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
//   * In-memory SQLite shimmed as D1 (same shape as annotation.test.ts).
//   * Hono harness that injects user/authMethod so we skip real auth.
//   * Drive annotationRoutes (scrobble) → assert D1 now_playing row, then
//     nowPlayingRoutes → assert response XML, visibility filter, minutesAgo.
//
// Run: npx tsx test/now_playing.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { annotationRoutes } from "../worker/src/endpoints/subsonic/annotation";
import { nowPlayingRoutes } from "../worker/src/endpoints/subsonic/now_playing";

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
// Schema
// ---------------------------------------------------------------------------
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
      image_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      year INTEGER, genre TEXT, cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT,
      track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
      compilation INTEGER DEFAULT 0, participants TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    -- 108 -- song listings LEFT JOIN the preferred instance for physical fields
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL DEFAULT '',
      suffix TEXT DEFAULT '', content_type TEXT, bit_rate INTEGER, size INTEGER,
      duration INTEGER, missing INTEGER DEFAULT 0
    );
    CREATE TABLE annotations (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
      play_count INTEGER DEFAULT 0, play_date INTEGER,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      starred INTEGER DEFAULT 0, starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
    -- 090: now_playing moved from KV to D1
    CREATE TABLE now_playing (
      username TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('bob', 'x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('admin', 'x', 3);

    INSERT INTO user_permissions VALUES (2, 'edit_annotations', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'browse', 1, 0);
    INSERT INTO user_permissions VALUES (3, 'edit_annotations', 1, 0);
    INSERT INTO user_permissions VALUES (3, 'browse', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'view_all_users_items', 0, 0);
    INSERT INTO user_permissions VALUES (3, 'view_all_users_items', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO albums (id, name, year) VALUES ('al-1', 'First Album', 2001);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-1', 'ar-1', 'Song A', 1, 180);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-2', 'al-1', 'ar-1', 'Song B', 2, 200);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Harness — 090: env no longer needs KV for now_playing / scrobble
// ---------------------------------------------------------------------------
function makeApp(
  sqlite: DatabaseSync,
  user: { username: string; level: number },
) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: user.username, level: user.level, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", annotationRoutes);
  app.route("/rest", nowPlayingRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    env,
    async hit(method: "GET" | "POST", url: string) {
      const req = new Request(`http://test${url}`, { method });
      return app.fetch(req, env);
    },
  };
}

async function main() {
  console.log("scrobble: submission=true writes now_playing D1 row AND annotations");
  {
    const sqlite = buildDb();
    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });

    const r = await hit("GET", "/rest/scrobble?id=sg-1&c=DSub");
    assert(r.status === 200, "scrobble returns 200");
    const text = await r.text();
    assert(text.includes('status="ok"'), "scrobble OK");

    // D1 now_playing row
    const npRow = sqlite.prepare(
      "SELECT song_id, started_at, client_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow !== undefined, "D1 now_playing row for alice exists");
    assert(npRow?.song_id === "sg-1", "songId stored");
    assert(npRow?.client_id === "DSub", "clientId stored from `c` param");
    assert(typeof npRow?.started_at === "number" && npRow?.started_at > 0, "startedAt unix sec");

    // D1 annotations row
    const row = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE user_id='alice' AND item_id='sg-1' AND item_type='song'"
    ).get() as any;
    assert(row?.play_count === 1, "D1 play_count=1 after submission=true");
  }

  console.log("scrobble: submission=false writes now_playing D1 row only (no annotations row)");
  {
    const sqlite = buildDb();
    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });

    const r = await hit("GET", "/rest/scrobble?id=sg-2&submission=false&c=Symfonium");
    assert(r.status === 200, "scrobble (now-playing) returns 200");

    const npRow = sqlite.prepare(
      "SELECT song_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow?.song_id === "sg-2", "D1 now_playing row has sg-2");

    const row = sqlite.prepare(
      "SELECT 1 FROM annotations WHERE user_id='alice' AND item_id='sg-2'"
    ).get() as any;
    assert(row === undefined, "no annotations row for now-playing-only scrobble");
  }

  console.log("scrobble: multi id → last id wins in now_playing table");
  {
    const sqlite = buildDb();
    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });

    await hit("GET", "/rest/scrobble?id=sg-1&id=sg-2");
    const npRow = sqlite.prepare(
      "SELECT song_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow?.song_id === "sg-2", "last id (sg-2) becomes now-playing");
    const rowA = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE item_id='sg-1' AND user_id='alice'"
    ).get() as any;
    const rowB = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE item_id='sg-2' AND user_id='alice'"
    ).get() as any;
    assert(rowA?.play_count === 1 && rowB?.play_count === 1, "both songs got D1 play_count++");
  }

  console.log("getNowPlaying: empty result when now_playing table is empty");
  {
    const sqlite = buildDb();
    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await hit("GET", "/rest/getNowPlaying");
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(text.includes('status="ok"'), "ok status");
    assert(text.includes("<nowPlaying"), "nowPlaying wrapper");
    assert(!text.includes("<entry"), "no entry when empty");
  }

  console.log("getNowPlaying: non-admin sees ONLY their own entry");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    // Pre-seed D1 now_playing table
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("alice", "sg-1", now - 120, "DSub", now);
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("bob", "sg-2", now - 60, "Symfonium", now);

    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await hit("GET", "/rest/getNowPlaying");
    const text = await r.text();
    assert(text.includes('username="alice"'), "sees own row");
    assert(!text.includes('username="bob"'), "does NOT see bob");
    assert(text.includes('playerId="DSub"'), "playerId=DSub");
    // minutesAgo: (~120s elapsed) → 2
    assert(/minutesAgo="2"/.test(text), "minutesAgo computed (~2 min)");
    assert(text.includes('title="Song A"'), "song title from D1");
    assert(text.includes('artist="Artist One"'), "artist name joined");
    assert(text.includes('album="First Album"'), "album name joined");
  }

  console.log("getNowPlaying: admin (level=3) sees ALL entries");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("alice", "sg-1", now - 30, "DSub", now);
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("bob", "sg-2", now - 30, "Symfonium", now);

    const { hit } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await hit("GET", "/rest/getNowPlaying");
    const text = await r.text();
    assert(text.includes('username="alice"'), "admin sees alice");
    assert(text.includes('username="bob"'), "admin sees bob");
  }

  console.log("getNowPlaying: drops stale entries (updated_at older than 300s)");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    // Insert a row that's 301 seconds old (expired)
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("alice", "sg-1", now - 400, "DSub", now - 301);

    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await hit("GET", "/rest/getNowPlaying");
    const text = await r.text();
    assert(text.includes("<nowPlaying"), "wrapper");
    assert(!text.includes("<entry"), "stale entry filtered out");
  }

  console.log("getNowPlaying: drops entries whose song was deleted");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("alice", "sg-DELETED", now, "DSub", now);

    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await hit("GET", "/rest/getNowPlaying");
    const text = await r.text();
    assert(text.includes("<nowPlaying"), "wrapper");
    assert(!text.includes("<entry"), "entry dropped because song missing");
  }

  console.log("getNowPlaying: .view alias works");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO now_playing (username, song_id, started_at, client_id, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("alice", "sg-1", now, "DSub", now);
    const { hit } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await hit("GET", "/rest/getNowPlaying.view");
    assert(r.status === 200, ".view returns 200");
    assert((await r.text()).includes('username="alice"'), ".view returns same body");
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
