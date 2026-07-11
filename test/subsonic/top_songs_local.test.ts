//
// Strategy:
//  * In-memory SQLite shimmed as D1.
//  * KV stub (used for lastfm 24h cache + feature_strings 60s cache).
//  * Stubbed global fetch so we control whether last.fm "answers" or 401s.
//  * Hono route directly invoked.
//
// Run: npx tsx test/subsonic/top_songs_local.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { infoRoutes } from "../../worker/src/endpoints/subsonic/info";

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
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
}

function buildDb(opts: { lastfmKey: string }) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
      description TEXT, updated_at INTEGER DEFAULT 0
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
      id TEXT PRIMARY KEY, album_id TEXT, artist_id TEXT,
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
    -- 090: lastfm cache moved from KV to D1
    CREATE TABLE lastfm_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    INSERT INTO feature_strings (key, value) VALUES ('lastfm_api_key', '${opts.lastfmKey}');

    INSERT INTO artists (id, name, sort_name) VALUES ('ar-adele', 'Adele', 'Adele');
    INSERT INTO albums (id, name, year) VALUES ('al-25', '25', 2015);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, created_at)
      VALUES ('sg-hello', 'al-25', 'ar-adele', 'Hello', 1, 295, 100);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, created_at)
      VALUES ('sg-whenwe', 'al-25', 'ar-adele', 'When We Were Young', 2, 290, 200);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, created_at)
      VALUES ('sg-cold', 'al-25', 'ar-adele', 'Million Years Ago', 3, 280, 300);

    -- play_count: Hello=10 (alice 6 + bob 4), WhenWe=3 (alice), Cold=0
    INSERT INTO annotations (user_id, item_id, item_type, play_count) VALUES
      ('alice', 'sg-hello', 'song', 6),
      ('bob',   'sg-hello', 'song', 4),
      ('alice', 'sg-whenwe', 'song', 3);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.route("/rest", infoRoutes);
  const env = { DB: makeD1(sqlite), KV: makeKV(), INSTANCE_ID: "test-instance" };
  return {
    env,
    async get(url: string) {
      return app.fetch(new Request(`http://test${url}`), env);
    },
  };
}

interface FetchCall { url: string; method: string; }
let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response> = () =>
  new Response("{}", { headers: { "Content-Type": "application/json" } });
const originalFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const call: FetchCall = { url, method };
    fetchCalls.push(call);
    return fetchHandler(call);
  }) as any;
}
function restoreFetch() { globalThis.fetch = originalFetch; }
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

async function main() {
  installFetchStub();

  console.log("getTopSongs: local-first ordering (no last.fm needed when local fills count)");
  {
    fetchCalls = [];
    fetchHandler = () => { throw new Error("should not be called when local fills"); };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs?artist=Adele&count=2");
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(/status="ok"/.test(text), "status=ok");
    // play_count: Hello=10, WhenWe=3. count=2 → both local; Cold (0 plays) excluded
    // by LIMIT. Order: Hello first, WhenWe second.
    const helloIdx = text.indexOf('title="Hello"');
    const whenWeIdx = text.indexOf('title="When We Were Young"');
    assert(helloIdx > -1 && whenWeIdx > -1, "both songs present");
    assert(helloIdx < whenWeIdx, "Hello before WhenWe (higher play_count)");
    assert(!text.includes('title="Million Years Ago"'), "Cold excluded by LIMIT=2");
    assert(fetchCalls.length === 0, "no last.fm call when local fills count");
  }

  console.log("getTopSongs: works with lastfm UNCONFIGURED (key empty)");
  {
    fetchCalls = [];
    fetchHandler = () => { throw new Error("should not be called when key empty"); };
    const sqlite = buildDb({ lastfmKey: "" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs?artist=Adele&count=50");
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(/status="ok"/.test(text), "status=ok (NOT failed code 30) when local has data");
    // All 3 songs returned, played first then unplayed (ties broken by created_at DESC).
    assert(text.includes('title="Hello"'), "Hello present");
    assert(text.includes('title="When We Were Young"'), "WhenWe present");
    assert(text.includes('title="Million Years Ago"'), "Cold present");
    assert(fetchCalls.length === 0, "no outbound fetch when lastfm unconfigured");
  }

  console.log("getTopSongs: count > local → calls last.fm to top up + dedupes");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getTopTracks")) {
        return jsonResponse({
          toptracks: {
            track: [
              // Hello again — should be deduped (already in local list).
              { name: "Hello", artist: { name: "Adele" }, playcount: "9999" },
              // Cold matches a local song that was 0-played → top-up adds it.
              { name: "Million Years Ago", artist: { name: "Adele" }, playcount: "100" },
              // Foreign track with no local match → silently dropped.
              { name: "Skyfall", artist: { name: "Adele" }, playcount: "50" },
            ],
          },
        });
      }
      return jsonResponse({});
    };
    // Build DB but ZERO local play counts so local returns 3 rows then we need
    // last.fm top-up. Actually with no play_count, the LIMIT in
    // getTopSongsByArtist with count=5 returns all 3 local rows (Hello/WhenWe/
    // Cold) because the LIMIT is by count. To force a top-up, we restrict
    // count > 3.
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    // Remove "Million Years Ago" from local so last.fm gets to add it.
    sqlite.exec("DELETE FROM song_masters WHERE id = 'sg-cold'");
    // Re-insert Cold via fallback path: keep it in DB so findSongByTitleAndArtist
    // matches. Actually we WANT it in DB so the reverse-lookup hits.
    sqlite.exec(`
      INSERT INTO song_masters (id, album_id, artist_id, title, track, duration, created_at)
      VALUES ('sg-cold-new', 'al-25', 'ar-adele', 'Million Years Ago', 3, 280, 300);
    `);
    const { get } = makeApp(sqlite);
    // count=3: local returns 2 (Hello/WhenWe; Cold has no plays but local query
    // LIMITs by count → returns top 3 by play_count which is Hello, WhenWe, Cold).
    // To force top-up we set count larger than local result OR remove a row.
    // The cleanest: count=10, but local will also include Cold (3 rows total).
    // Then last.fm tries to add Hello (deduped) and Cold (deduped) and Skyfall
    // (no match). Net: matched stays at 3. Let's assert dedup explicitly.
    const r = await get("/rest/getTopSongs?artist=Adele&count=10");
    assert(r.status === 200, "200");
    const text = await r.text();
    const helloCount = (text.match(/title="Hello"/g) || []).length;
    assert(helloCount === 1, `Hello appears exactly once (got ${helloCount})`);
    const coldCount = (text.match(/title="Million Years Ago"/g) || []).length;
    assert(coldCount === 1, `Cold appears exactly once (dedupe across local+lastfm)`);
    assert(!text.includes("Skyfall"), "Skyfall dropped (no local match)");
    assert(fetchCalls.some((c) => c.url.includes("method=artist.getTopTracks")),
      "last.fm WAS called because local count < requested count");
  }

  console.log("getTopSongs: count > local and lastfm errors → still returns local partial");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("upstream 500", { status: 500 });
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs?artist=Adele&count=20");
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(/status="ok"/.test(text), "status=ok even when lastfm 500s, because local has rows");
    assert(text.includes('title="Hello"'), "local row still present");
  }

  console.log("getTopSongs: unknown artist → empty (no error)");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getTopTracks")) {
        return jsonResponse({ toptracks: { track: [] } });
      }
      return jsonResponse({});
    };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs?artist=NobodyKnows&count=5");
    assert(r.status === 200, "200");
    const text = await r.text();
    assert(/status="ok"/.test(text), "ok");
    assert(/<topSongs>\s*<\/topSongs>|<topSongs\s*\/>/.test(text)
      || text.includes('<topSongs>'), "topSongs wrapper present");
    assert(!text.includes('<song '), "no song entries");
  }

  console.log("getTopSongs: missing artist param → code 10");
  {
    fetchCalls = [];
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs");
    const text = await r.text();
    assert(/code="10"/.test(text), "code 10 missing artist");
  }

  restoreFetch();
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
