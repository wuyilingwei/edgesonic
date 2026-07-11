// /tag/scrapeHistory.
//
// Strategy mirrors test/batch_write_tags.test.ts:
//  * In-memory SQLite (node:sqlite) shimmed as D1.
//  * Hono harness injects an authenticated session user.
//  * The proxy path is exercised with a stubbed global fetch so we never hit
//   the real NetEase/QQ/Kugou endpoints.
//
// Run: npx tsx test/scrape.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { scrapeRoutes } from "../worker/src/endpoints/tag/scrape";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1Database shim (same shape as batch_write_tags.test.ts)
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
// Schema seeded with the bits scrape.ts actually touches
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      album_id TEXT,
      artist_id TEXT
    );
    CREATE TABLE scrape_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      song_master_id TEXT,
      source TEXT NOT NULL,
      query TEXT,
      remote_song_id TEXT,
      result_json TEXT,
      status TEXT NOT NULL,
      mode TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('mallory', 'x', 2);
    INSERT INTO song_masters (id, title, album_id, artist_id) VALUES ('sg-1', 'Song One', 'al-x', 'ar-x');
    INSERT INTO song_masters (id, title, album_id, artist_id) VALUES ('sg-2', 'Song Two', 'al-x', 'ar-x');
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness — injects a `user` like the real auth middleware does.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, asUser = "alice") {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: asUser, level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", scrapeRoutes);
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
// global fetch stub — captures the URLs scrape.ts hits.
// ---------------------------------------------------------------------------
interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string | null; }
let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });

const originalFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const hdrIn = init?.headers as Record<string, string> | undefined;
    if (hdrIn) for (const [k, v] of Object.entries(hdrIn)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === "string" ? init!.body as string : null;
    const call: FetchCall = { url, method, headers, body };
    fetchCalls.push(call);
    return fetchHandler(call);
  }) as any;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

// ---------------------------------------------------------------------------
async function main() {
installFetchStub();

console.log("scrapeMetadata: netease search routes to music.163.com with Referer:");
{
  fetchCalls = [];
  fetchHandler = () =>
    new Response(JSON.stringify({ result: { songs: [{ id: 42, name: "Hello", artists: [{ name: "Adele" }], album: { name: "25" } }] } }), {
      headers: { "Content-Type": "application/json" },
    });
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/scrape", { source: "netease", intent: "search", query: "Hello Adele" });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "body.ok true");
  assert(body.source === "netease" && body.intent === "search", "echoes source + intent");
  assert(body.data?.result?.songs?.[0]?.id === 42, "upstream data forwarded verbatim");
  assert(fetchCalls.length === 1, `one outbound fetch (got ${fetchCalls.length})`);
  assert(fetchCalls[0].url.includes("music.163.com/api/search/get/web"), "hit NetEase search endpoint");
  assert(fetchCalls[0].method === "POST", "POST method");
  assert(fetchCalls[0].headers["referer"] === "https://music.163.com/", "Referer header present");
  assert(fetchCalls[0].body?.includes("s=Hello+Adele") || fetchCalls[0].body?.includes("s=Hello%20Adele"), "query encoded in form body");
}

console.log("scrapeMetadata: qmusic search routes to c.y.qq.com with Referer:");
{
  fetchCalls = [];
  fetchHandler = () =>
    new Response(JSON.stringify({ data: { song: { list: [{ songmid: "ABC123", songname: "X", singer: [{ name: "Y" }], albumname: "Z" }] } } }), {
      headers: { "Content-Type": "application/json" },
    });
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/scrape", { source: "qmusic", intent: "search", query: "X Y" });
  assert(r.status === 200, "qmusic 200 status");
  const body = await r.json() as any;
  assert(body.data?.data?.song?.list?.[0]?.songmid === "ABC123", "qmusic upstream forwarded");
  assert(fetchCalls[0].url.includes("c.y.qq.com/soso/fcgi-bin/client_search_cp"), "hit QQ Music endpoint");
  assert(fetchCalls[0].headers["referer"] === "https://y.qq.com/", "QQ Music Referer header");
}

console.log("scrapeMetadata: validation errors:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);

  const r1 = await post("/tag/scrape", { source: "bogus", intent: "search", query: "x" });
  assert(r1.status === 400, `unknown source → 400 (got ${r1.status})`);

  const r2 = await post("/tag/scrape", { source: "netease", intent: "search" });
  assert(r2.status === 400, "missing query for search → 400");

  const r3 = await post("/tag/scrape", { source: "netease", intent: "lyric" });
  assert(r3.status === 400, "missing songId for lyric → 400");
}

console.log("scrapeMetadata: upstream HTTP failure surfaces 502:");
{
  fetchCalls = [];
  fetchHandler = () => new Response("upstream blew up", { status: 503 });
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/scrape", { source: "kugou", intent: "search", query: "x" });
  assert(r.status === 502, `503 upstream → 502 (got ${r.status})`);
  const body = await r.json() as any;
  assert(/HTTP 503/.test(body.error), `error mentions 503 (got ${body.error})`);
}

console.log("submitScrapeResult: happy path inserts an applied row:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const result = { source: "netease", songId: "42", title: "Hello", artist: "Adele", album: "25" };
  const r = await post("/tag/submitScrape", {
    songMasterId: "sg-1",
    source: "netease",
    songId: "42",
    query: "Hello Adele",
    result,
    mode: "tags",
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true && body.id && body.status === "applied", "ok response with id + status=applied");
  assert(body.songMasterId === "sg-1", "songMasterId echoed");

  const row = sqlite.prepare("SELECT * FROM scrape_jobs WHERE id = ?").get(body.id) as any;
  assert(row, "row inserted in scrape_jobs");
  assert(row.user_id === "alice", "user_id stamped from auth user");
  assert(row.song_master_id === "sg-1", "song_master_id stored");
  assert(row.source === "netease", "source stored");
  assert(row.status === "applied", "status applied");
  assert(row.mode === "tags", "mode tags");
  const parsed = JSON.parse(row.result_json);
  assert(parsed.title === "Hello" && parsed.artist === "Adele", "result_json preserves payload");
}

console.log("submitScrapeResult: stale songMasterId → stored as null but row still inserted:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r = await post("/tag/submitScrape", {
    songMasterId: "sg-ghost",
    source: "netease",
    result: { title: "X" },
  });
  assert(r.status === 200, "200 even with stale id");
  const body = await r.json() as any;
  assert(body.songMasterId === null, "echoed null for stale id");
  const row = sqlite.prepare("SELECT song_master_id FROM scrape_jobs WHERE id = ?").get(body.id) as any;
  assert(row.song_master_id === null, "row stores null for stale id");
}

console.log("submitScrapeResult: validation errors:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const r1 = await post("/tag/submitScrape", { source: "bogus", result: {} });
  assert(r1.status === 400, "unknown source → 400");
  const r2 = await post("/tag/submitScrape", { source: "netease" });
  assert(r2.status === 400, "missing result → 400");
  const r3 = await post("/tag/submitScrape", { source: "netease", result: {}, mode: "wat" });
  assert(r3.status === 400, "invalid mode → 400");
}

console.log("getScrapeHistory: pagination + per-user isolation:");
{
  const sqlite = buildDb();
  // Seed 5 alice rows + 2 mallory rows, with distinct created_at.
  for (let i = 0; i < 5; i++) {
    sqlite.prepare(
      "INSERT INTO scrape_jobs (id, user_id, song_master_id, source, query, result_json, status, mode, created_at) VALUES (?, 'alice', 'sg-1', 'netease', ?, '{}', 'applied', 'tags', ?)"
    ).run(`sj-a-${i}`, `q-${i}`, 1000 + i);
  }
  sqlite.prepare(
    "INSERT INTO scrape_jobs (id, user_id, song_master_id, source, query, result_json, status, mode, created_at) VALUES ('sj-m-1', 'mallory', 'sg-2', 'qmusic', 'mq', '{}', 'applied', 'tags', 9999)"
  ).run();
  sqlite.prepare(
    "INSERT INTO scrape_jobs (id, user_id, song_master_id, source, query, result_json, status, mode, created_at) VALUES ('sj-m-2', 'mallory', 'sg-2', 'qmusic', 'mq', '{}', 'applied', 'tags', 9998)"
  ).run();

  // alice sees only her 5 rows, sorted desc by created_at.
  const { get } = makeApp(sqlite, "alice");
  const r1 = await get("/tag/scrapeHistory?limit=3&offset=0");
  assert(r1.status === 200, "history 200 status");
  const b1 = await r1.json() as any;
  assert(b1.ok === true, "ok");
  assert(Array.isArray(b1.items) && b1.items.length === 3, `3 rows on first page (got ${b1.items?.length})`);
  assert(b1.items[0].id === "sj-a-4", `newest first (got ${b1.items[0].id})`);
  assert(b1.items.every((r: any) => r.source === "netease"), "all rows belong to alice");
  assert(b1.limit === 3 && b1.offset === 0, "limit/offset echoed");

  // Page 2 = remaining 2.
  const r2 = await get("/tag/scrapeHistory?limit=3&offset=3");
  const b2 = await r2.json() as any;
  assert(b2.items.length === 2, `2 rows on second page (got ${b2.items.length})`);

  // mallory's view doesn't leak across users.
  const { get: malGet } = makeApp(sqlite, "mallory");
  const rm = await malGet("/tag/scrapeHistory?limit=10");
  const bm = await rm.json() as any;
  assert(bm.items.length === 2, "mallory sees 2 rows only");
  assert(bm.items.every((r: any) => r.source === "qmusic"), "mallory rows isolated");

  // Filter by songMasterId.
  const rf = await get("/tag/scrapeHistory?songMasterId=sg-1&limit=10");
  const bf = await rf.json() as any;
  assert(bf.items.length === 5, "songMasterId filter returns all 5 matching rows");
}

console.log("getScrapeHistory: bad limit/offset clamped:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite);
  const r = await get("/tag/scrapeHistory?limit=9999&offset=-1");
  assert(r.status === 200, "still 200");
  const b = await r.json() as any;
  assert(b.limit <= 200, `limit capped at 200 (got ${b.limit})`);
  assert(b.offset >= 0, "offset clamped to 0");
}

console.log("submitScrapeResult: payload too large rejected:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite);
  const huge = "x".repeat(70 * 1024);
  const r = await post("/tag/submitScrape", {
    source: "netease",
    result: { blob: huge },
  });
  assert(r.status === 400, "oversize payload → 400");
}

// ---------------------------------------------------------------------------
restoreFetch();
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => { console.error(err); process.exit(1); },
);
