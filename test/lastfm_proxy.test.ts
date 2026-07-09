// Tests for task 043 — /rest/getArtistInfo[2], /rest/getAlbumInfo[2],
// /rest/getSimilarSongs[2], /rest/getTopSongs.
//
// Strategy mirrors test/scrape.test.ts:
//   * In-memory SQLite shimmed as D1.
//   * Hono harness for routing (info endpoints carry no auth middleware).
//   * In-memory KV stub so we can verify the 24h cache layer.
//   * Stubbed global fetch so we never hit ws.audioscrobbler.com.
//
// Run: npx tsx test/lastfm_proxy.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { infoRoutes } from "../worker/src/endpoints/subsonic/info";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1Database shim (same shape as scrape.test.ts)
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
// In-memory KV. Tracks put/get/delete + lets the test inspect what was
// cached. We don't bother enforcing TTL — getFeatureString has its own
// 60s shape and lastfm 24h shape, both irrelevant here.
// ---------------------------------------------------------------------------
function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
}

// ---------------------------------------------------------------------------
// Schema seeded with the bits info.ts actually touches
// ---------------------------------------------------------------------------
function buildDb(opts: { lastfmKey: string }) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      description TEXT,
      updated_at INTEGER DEFAULT 0
    );
    -- 090: lastfm cache moved from KV to D1
    CREATE TABLE lastfm_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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
      album_id TEXT,
      artist_id TEXT,
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
    -- 047: getTopSongs now joins annotations for local-first ranking.
    CREATE TABLE annotations (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
      play_count INTEGER DEFAULT 0, play_date INTEGER,
      rating INTEGER CHECK (rating BETWEEN 1 AND 5),
      starred INTEGER DEFAULT 0, starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );

    INSERT INTO feature_strings (key, value) VALUES ('lastfm_api_key', '${opts.lastfmKey}');

    -- Adele + her album + two songs
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-adele', 'Adele', 'Adele');
    INSERT INTO albums (id, name, year, song_count, duration) VALUES ('al-25', '25', 2015, 2, 600);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-hello', 'al-25', 'ar-adele', 'Hello', 1, 295);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-whenwe', 'al-25', 'ar-adele', 'When We Were Young', 2, 290);

    -- Another artist in the catalogue so similar-artist resolution can hit.
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-sam', 'Sam Smith', 'Sam Smith');
    INSERT INTO albums (id, name, year) VALUES ('al-spirit', 'In the Lonely Hour', 2014);
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-stay', 'al-spirit', 'ar-sam', 'Stay With Me', 1, 172);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness — info endpoints don't carry auth middleware, just route.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.route("/rest", infoRoutes);
  const env = { DB: makeD1(sqlite), KV: makeKV(), INSTANCE_ID: "test-instance" };
  return {
    env,
    async get(url: string) {
      const req = new Request(`http://test${url}`);
      return app.fetch(req, env);
    },
  };
}

// ---------------------------------------------------------------------------
// global fetch stub
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
async function main() {
  installFetchStub();

  console.log("getArtistInfo: missing api_key → Subsonic error code 30:");
  {
    fetchCalls = [];
    const sqlite = buildDb({ lastfmKey: "" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo?id=ar-adele");
    assert(r.status === 200, "200 status (Subsonic encodes errors in body)");
    const text = await r.text();
    assert(/code="30"/.test(text), `XML contains code="30" (got: ${text.slice(0, 200)})`);
    assert(/status="failed"/.test(text), "status=failed in XML");
    assert(fetchCalls.length === 0, "no outbound fetch when key missing");
  }

  console.log("getArtistInfo: happy path forwards bio + images + similarArtist:");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getInfo")) {
        return jsonResponse({
          artist: {
            name: "Adele",
            mbid: "cc2c9c3c-b7bc-4b8b-84d8-4fbd8779e493",
            url: "https://www.last.fm/music/Adele",
            image: [
              { size: "small", "#text": "https://img/sm.png" },
              { size: "medium", "#text": "https://img/md.png" },
              { size: "large", "#text": "https://img/lg.png" },
              { size: "extralarge", "#text": "https://img/xl.png" },
            ],
            bio: {
              summary: "Adele is a British singer. <a href=\"https://www.last.fm/music/Adele\">Read more on Last.fm</a>",
              content: "Adele Laurie Blue Adkins MBE is an English singer-songwriter. <a href=\"http://last.fm\">Read more</a>",
            },
          },
        });
      }
      if (call.url.includes("method=artist.getSimilar")) {
        return jsonResponse({
          similarartists: {
            artist: [
              { name: "Sam Smith", mbid: "abc", url: "https://last.fm/sam", image: [] },
              { name: "Some Random", mbid: "", url: "https://last.fm/sr", image: [] },
            ],
          },
        });
      }
      return jsonResponse({});
    };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo?id=ar-adele&count=5");
    assert(r.status === 200, "200 status");
    const text = await r.text();
    assert(/status="ok"/.test(text), "status=ok in XML");
    assert(/<artistInfo>/.test(text), "artistInfo element emitted");
    assert(/<biography>[^<]*English singer-songwriter/.test(text), "biography text included");
    assert(!/Read more/.test(text), "anchor 'Read more' link stripped");
    assert(/<musicBrainzId>cc2c9c3c/.test(text), "musicBrainzId emitted");
    assert(/<lastFmUrl>https:\/\/www\.last\.fm\/music\/Adele<\/lastFmUrl>/.test(text), "lastFmUrl emitted");
    assert(/<smallImageUrl>https:\/\/img\/sm\.png<\/smallImageUrl>/.test(text), "smallImageUrl");
    assert(/<largeImageUrl>https:\/\/img\/xl\.png<\/largeImageUrl>/.test(text),
      "largeImageUrl uses extralarge (largest available)");
    // Attribute order in our XML serializer is dictated by object key order.
    // Both attributes are present in the same element; assert each separately.
    assert(/<similarArtist [^>]*id="ar-sam"[^>]*\/>/.test(text), "similarArtist Sam Smith resolved to local id");
    assert(/<similarArtist [^>]*name="Sam Smith"[^>]*\/>/.test(text), "similarArtist name attr present");
    // includeNotPresent defaults to false → 'Some Random' should be excluded.
    assert(!/name="Some Random"/.test(text), "unmatched similarArtist dropped by default");
  }

  console.log("getArtistInfo: includeNotPresent=true keeps unmatched similar artists:");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getInfo")) {
        return jsonResponse({ artist: { name: "Adele", bio: { summary: "" } } });
      }
      if (call.url.includes("method=artist.getSimilar")) {
        return jsonResponse({ similarartists: { artist: [{ name: "Some Random" }] } });
      }
      return jsonResponse({});
    };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo?id=ar-adele&includeNotPresent=true");
    const text = await r.text();
    assert(/name="Some Random"/.test(text), "unmatched similar artist now included");
    assert(!/id="[^"]+" name="Some Random"/.test(text), "no id attribute for unmatched artist");
  }

  console.log("getArtistInfo2: same handler, different wrapper element:");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getInfo")) {
        return jsonResponse({ artist: { name: "Adele", bio: { summary: "Hello." } } });
      }
      return jsonResponse({ similarartists: { artist: [] } });
    };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo2?id=ar-adele");
    const text = await r.text();
    assert(/<artistInfo2>/.test(text), "artistInfo2 wrapper");
  }

  console.log("getAlbumInfo: notes + images + identifiers:");
  {
    fetchCalls = [];
    fetchHandler = () => jsonResponse({
      album: {
        name: "25", artist: "Adele",
        mbid: "album-mbid", url: "https://last.fm/album/25",
        image: [
          { size: "small", "#text": "https://img/al-sm.png" },
          { size: "large", "#text": "https://img/al-lg.png" },
        ],
        wiki: {
          summary: "25 is the third studio album. <a href=\"x\">More</a>",
          content: "25 is the third studio album by English singer Adele. <a href=\"x\">More</a>",
        },
      },
    });
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getAlbumInfo?id=al-25");
    const text = await r.text();
    assert(/<albumInfo>/.test(text), "albumInfo wrapper");
    assert(/<notes>25 is the third studio album by English singer Adele\./.test(text), "notes text from wiki.content");
    assert(!/More<\/a>/.test(text), "wiki anchor stripped");
    assert(/<musicBrainzId>album-mbid/.test(text), "album mbid");
    assert(/<smallImageUrl>https:\/\/img\/al-sm\.png/.test(text), "album smallImageUrl");
    assert(/<largeImageUrl>https:\/\/img\/al-lg\.png/.test(text), "album largeImageUrl");
    assert(fetchCalls.length === 1 && fetchCalls[0].url.includes("method=album.getInfo"), "hit album.getInfo");
  }

  console.log("getSimilarSongs: matched rows resolved, unmatched dropped:");
  {
    fetchCalls = [];
    fetchHandler = () => jsonResponse({
      similartracks: {
        track: [
          { name: "Stay With Me", artist: { name: "Sam Smith" }, mbid: "" },
          { name: "Total Stranger", artist: { name: "Nobody" }, mbid: "" },
        ],
      },
    });
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getSimilarSongs?id=sg-hello&count=10");
    const text = await r.text();
    assert(/<similarSongs>/.test(text), "similarSongs wrapper");
    // Stay With Me exists in the DB → must appear with its local id.
    assert(/<song [^>]*id="sg-stay"/.test(text), "matched track emitted with local id");
    assert(/<song [^>]*title="Stay With Me"/.test(text), "matched track title");
    // The unmatched track must not appear.
    assert(!/Total Stranger/.test(text), "unmatched track dropped");
    assert(fetchCalls.length === 1, `one outbound fetch (got ${fetchCalls.length})`);
    assert(fetchCalls[0].url.includes("method=track.getSimilar"), "hit track.getSimilar");
  }

  console.log("getTopSongs: top tracks resolved against local catalogue:");
  {
    fetchCalls = [];
    fetchHandler = () => jsonResponse({
      toptracks: {
        track: [
          { name: "Hello", artist: { name: "Adele" }, playcount: "1000" },
          { name: "When We Were Young", artist: { name: "Adele" }, playcount: "900" },
          { name: "Skyfall", artist: { name: "Adele" }, playcount: "800" },
        ],
      },
    });
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getTopSongs?artist=Adele&count=10");
    const text = await r.text();
    assert(/<topSongs>/.test(text), "topSongs wrapper");
    assert(/<song [^>]*id="sg-hello"/.test(text), "Hello resolved");
    assert(/<song [^>]*id="sg-whenwe"/.test(text), "When We Were Young resolved");
    assert(!/Skyfall/.test(text), "Skyfall not in library, dropped");
    assert(fetchCalls.length === 1 && fetchCalls[0].url.includes("method=artist.getTopTracks"), "hit artist.getTopTracks");
  }

  // 090 — cache moved from KV to D1 `lastfm_cache` table.
  console.log("D1 cache: repeat call within TTL hits cache (no second fetch):");
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.includes("method=artist.getInfo")) {
        return jsonResponse({ artist: { name: "Adele", bio: { summary: "Cached body." } } });
      }
      return jsonResponse({ similarartists: { artist: [] } });
    };
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r1 = await get("/rest/getArtistInfo?id=ar-adele&count=2");
    assert(r1.status === 200, "first call ok");
    const firstFetchCount = fetchCalls.length;
    assert(firstFetchCount === 2, `first call made 2 outbound fetches (got ${firstFetchCount})`);
    // D1 lastfm_cache should now hold two cache entries
    const cachedCount = (sqlite.prepare(
      "SELECT COUNT(*) AS cnt FROM lastfm_cache WHERE cache_key LIKE 'lastfm:%'"
    ).get() as any)?.cnt ?? 0;
    assert(cachedCount === 2, `D1 lastfm_cache holds 2 entries (got ${cachedCount})`);

    const r2 = await get("/rest/getArtistInfo?id=ar-adele&count=2");
    assert(r2.status === 200, "second call ok");
    assert(fetchCalls.length === firstFetchCount,
      `no new fetch on D1 cache hit (calls before: ${firstFetchCount}, after: ${fetchCalls.length})`);
    const text2 = await r2.text();
    assert(/Cached body/.test(text2), "cached body returned on second call");
  }

  console.log("upstream HTTP failure surfaces as Subsonic error code 0:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("upstream is sad", { status: 503 });
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo?id=ar-adele");
    const text = await r.text();
    assert(/status="failed"/.test(text), "status=failed on upstream error");
    assert(/code="0"/.test(text), "code=0 (generic error) for upstream failure");
    assert(/HTTP 503/.test(text), "503 surfaced in message");
  }

  console.log("missing id → Subsonic error code 10:");
  {
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo");
    const text = await r.text();
    assert(/code="10"/.test(text), "code=10 for missing param");
  }

  console.log("nonexistent artist id → code 70:");
  {
    const sqlite = buildDb({ lastfmKey: "TESTKEY" });
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getArtistInfo?id=ar-ghost");
    const text = await r.text();
    assert(/code="70"/.test(text), "code=70 not found");
  }

  // -------------------------------------------------------------------------
  restoreFetch();
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => { console.error(err); process.exit(1); },
);
