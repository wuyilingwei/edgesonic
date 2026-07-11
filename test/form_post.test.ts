//
// Strategy:
//  * Install formPostMiddleware in front of routes that read both
//   query params and parseBody() — confirms the merge works transparently.
//  * Drive scrobble (query-only) and createPlaylist (parseBody) via real
//   Hono fetch with Content-Type: application/x-www-form-urlencoded bodies.
//  * Also test that JSON & multipart bodies pass through untouched.
//
// Run: npx tsx test/form_post.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { formPostMiddleware } from "../worker/src/middleware/form_post";
import { annotationRoutes } from "../worker/src/endpoints/subsonic/annotation";
import { playlistsRoutes } from "../worker/src/endpoints/subsonic/playlists";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 + KV shim (reused from now_playing.test.ts shape)
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
      async run(): Promise<{ success: true; meta: { changes: number; last_row_id?: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
    };
  }
  return {
    prepare,
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
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
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE annotations (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
      play_count INTEGER DEFAULT 0, play_date INTEGER,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      starred INTEGER DEFAULT 0, starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      comment TEXT,
      owner TEXT NOT NULL,
      public INTEGER DEFAULT 0,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      cover_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE playlist_songs (
      playlist_id TEXT NOT NULL,
      song_master_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, position)
    );
    CREATE TABLE now_playing (
      username TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO user_permissions VALUES (2, 'edit_annotations', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'browse', 1, 0);
    INSERT INTO user_permissions VALUES (2, 'manage_playlists', 1, 0);

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist One');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album One');
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-1', 'ar-1', 'Song A', 1, 180);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-2', 'al-1', 'ar-1', 'Song B', 2, 200);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Harness: mount formPostMiddleware on /rest/* BEFORE route handlers, mirror
// production wiring.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  const kv = makeKV();
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("/rest/*", formPostMiddleware);
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", annotationRoutes);
  app.route("/rest", playlistsRoutes);
  const env = { DB: makeD1(sqlite), KV: kv };
  return {
    env, kv,
    async fetch(method: "GET" | "POST", url: string, init: RequestInit = {}) {
      return app.fetch(new Request(`http://test${url}`, { method, ...init }), env);
    },
  };
}

async function main() {
  console.log("scrobble: POST application/x-www-form-urlencoded body params reach c.req.query()");
  {
    const sqlite = buildDb();
    const { fetch, kv } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/scrobble", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "id=sg-1&c=DSub&submission=true",
    });
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(text.includes('status="ok"'), "OK");
    const row = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE user_id='alice' AND item_id='sg-1'"
    ).get() as any;
    assert(row?.play_count === 1, "form-encoded id reached scrobble handler → D1 row written");
    const npRow = sqlite.prepare(
      "SELECT song_id, client_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow != null, "D1 now_playing written via form-encoded scrobble");
    assert(npRow?.client_id === "DSub", "clientId came from form `c` param");
  }

  console.log("scrobble: form-encoded submission=false correctly skips D1 write");
  {
    const sqlite = buildDb();
    const { fetch, kv } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/scrobble", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "id=sg-2&submission=false",
    });
    assert(r.status === 200, "200");
    const row = sqlite.prepare(
      "SELECT 1 FROM annotations WHERE user_id='alice' AND item_id='sg-2'"
    ).get() as any;
    assert(row === undefined, "no D1 row when submission=false");
    const npRow2 = sqlite.prepare(
      "SELECT song_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow2?.song_id === "sg-2", "D1 now_playing row written even when submission=false");
  }

  console.log("scrobble: mixed query + form body — repeated id keys collected as multi");
  {
    const sqlite = buildDb();
    const { fetch } = makeApp(sqlite);
    // URL has id=sg-1, body has id=sg-2 → handler should scrobble both.
    const r = await fetch("POST", "/rest/scrobble?id=sg-1", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "id=sg-2&submission=true",
    });
    assert(r.status === 200, "200");
    const r1 = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE item_id='sg-1' AND user_id='alice'"
    ).get() as any;
    const r2 = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE item_id='sg-2' AND user_id='alice'"
    ).get() as any;
    assert(r1?.play_count === 1 && r2?.play_count === 1,
      "both ids scrobbled (query id=sg-1 + form id=sg-2)");
  }

  console.log("createPlaylist: form-encoded name + multiple songId");
  {
    const sqlite = buildDb();
    const { fetch } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/createPlaylist", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=Road+Trip&songId=sg-1&songId=sg-2",
    });
    assert(r.status === 200, `200 (got ${r.status})`);
    const text = await r.text();
    assert(text.includes('status="ok"'), "ok");
    // Verify D1 — playlists.ts inserts a row with the name and song refs.
    const pl = sqlite.prepare("SELECT id, name FROM playlists WHERE owner='alice'").get() as any;
    assert(pl?.name === "Road Trip", `playlist name decoded (+→space), got ${pl?.name}`);
    const songs = sqlite.prepare(
      "SELECT song_master_id FROM playlist_songs WHERE playlist_id=? ORDER BY position"
    ).all(pl.id) as any[];
    assert(songs.length === 2, `2 songs added (got ${songs.length})`);
    assert(songs[0].song_master_id === "sg-1" && songs[1].song_master_id === "sg-2",
      "both songIds picked up from form body");
  }

  console.log("star: POST form body id reaches handler");
  {
    const sqlite = buildDb();
    const { fetch } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/star", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "id=sg-1",
    });
    assert(r.status === 200, "200");
    const row = sqlite.prepare(
      "SELECT starred FROM annotations WHERE user_id='alice' AND item_id='sg-1' AND item_type='song'"
    ).get() as any;
    assert(row?.starred === 1, "starred via form body");
  }

  console.log("JSON body POST: pass-through (NOT intercepted)");
  {
    // Pick an endpoint that genuinely reads JSON — we just send JSON to
    // /rest/scrobble (which reads query/form, not JSON) and confirm middleware
    // didn't munge it. Easiest verifiable signal: KV still gets a "now_playing"
    // row from the URL-encoded query, body is irrelevant.
    const sqlite = buildDb();
    const { fetch, kv } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/scrobble?id=sg-1", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ignored-because-json" }),
    });
    assert(r.status === 200, "200");
    const npRow3 = sqlite.prepare(
      "SELECT song_id FROM now_playing WHERE username='alice'"
    ).get() as any;
    assert(npRow3 != null, "D1 now_playing written from URL query (JSON body ignored)");
    assert(npRow3?.song_id === "sg-1", "song_id came from URL, not JSON");
  }

  console.log("Empty form body: no crash, no merge");
  {
    const sqlite = buildDb();
    const { fetch } = makeApp(sqlite);
    const r = await fetch("POST", "/rest/scrobble?id=sg-1", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert(r.status === 200, "200 even with empty form body");
    const row = sqlite.prepare(
      "SELECT play_count FROM annotations WHERE item_id='sg-1' AND user_id='alice'"
    ).get() as any;
    assert(row?.play_count === 1, "scrobble still used the URL id");
  }

  console.log("formPost: GET pass-through (middleware only fires on POST)");
  {
    const sqlite = buildDb();
    const { fetch } = makeApp(sqlite);
    // GETs cannot have form bodies; middleware should short-circuit.
    const r = await fetch("GET", "/rest/scrobble?id=sg-1");
    assert(r.status === 200, "GET 200");
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
