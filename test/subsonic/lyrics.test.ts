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
//  1. getLyrics — D1 hit (song_masters.lyrics populated) → returns XML with
//    both attributes + text body, never touches external fetch.
//  2. getLyrics — D1 miss, external NetEase stub returns lyric → endpoint
//    returns body AND song_masters.lyrics is filled.
//  3. getLyrics — both D1 and external miss → 200 with empty <lyrics/>.
//  4. getLyrics — missing both query params → 200 empty (Subsonic spec).
//  5. getLyricsBySongId — D1 miss → external hit → OpenSubsonic lyricsList.
//  6. getLyricsBySongId — id not found → 404 Subsonic error.
//
// Run: npx tsx test/subsonic/lyrics.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { lyricsRoutes } from "../../worker/src/endpoints/subsonic/lyrics";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim (same shape as batch_write_tags.test.ts / scrape.test.ts)
// ---------------------------------------------------------------------------
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
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      image_r2_key TEXT,
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
      lyrics TEXT,
      lyrics_rich TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    -- 108 -- song listings LEFT JOIN the preferred instance for physical fields
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL DEFAULT '',
      suffix TEXT DEFAULT '', content_type TEXT, bit_rate INTEGER, size INTEGER,
      duration INTEGER, missing INTEGER DEFAULT 0
    );
    -- 0259 -- song_artists table for getSongMaster's SONG_ROW_COLS JOIN
    CREATE TABLE song_artists (
      song_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (song_id, artist_id)
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO albums (id, name) VALUES ('al-1', '25');

    INSERT INTO artists (id, name) VALUES ('ar-1', 'Adele');
    INSERT INTO song_masters (id, album_id, artist_id, title, lyrics)
      VALUES ('sg-1', 'al-1', 'ar-1', 'Hello', '[00:00.00]Hello, it''s me\n[00:03.00]I was wondering');
    INSERT INTO song_masters (id, album_id, artist_id, title, lyrics)
      VALUES ('sg-2', 'al-1', 'ar-1', 'Skyfall', NULL);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.route("/rest", lyricsRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async get(url: string) {
      const req = new Request(`http://test${url}`);
      return app.fetch(req, env);
    },
  };
}

// ---------------------------------------------------------------------------
// Global fetch stub — captures NetEase calls + lets each test choose payload.
// ---------------------------------------------------------------------------
interface FetchCall { url: string; method: string; body: string | null; }
let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response> = () =>
  new Response("", { status: 500 });
const originalFetch = globalThis.fetch;
function installFetchStub() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init!.body as string : null;
    const call: FetchCall = { url, method, body };
    fetchCalls.push(call);
    return fetchHandler(call);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

// Convenient handler factory: behaves like NetEase — search returns one hit
// with the given id, then lyric returns `lrc`.
function neteaseHandler(songId: number, lrc: string): (c: FetchCall) => Response {
  return (call: FetchCall) => {
    if (call.url.includes("/api/search/get/web")) {
      return new Response(JSON.stringify({
        result: { songs: [{ id: songId, name: "Hello", artists: [{ name: "Adele" }] }] },
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (call.url.includes("/api/song/lyric")) {
      return new Response(JSON.stringify({ lrc: { lyric: lrc } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
async function main() {
  installFetchStub();

  console.log("getLyrics — D1 hit returns body without external fetch:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("UNEXPECTED", { status: 500 });
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyrics?artist=Adele&title=Hello");
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(xml.includes('artist="Adele"'), "echoes artist attribute");
    assert(xml.includes('title="Hello"'), "echoes title attribute");
    assert(xml.includes("Hello, it&apos;s me"), "embeds stored lyrics text (escaped)");
    assert(fetchCalls.length === 0, "did NOT hit external fetch (D1 already populated)");
  }

  console.log("\ngetLyrics — D1 miss, external NetEase hit writes back:");
  {
    fetchCalls = [];
    fetchHandler = neteaseHandler(99, "[00:00.00]External lyric\n[00:05.00]line two");
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyrics?artist=Adele&title=Skyfall");
    assert(r.status === 200, `200 status`);
    const xml = await r.text();
    assert(xml.includes("External lyric"), "body includes fetched lyric");
    assert(fetchCalls.length === 2, `two outbound calls (search + lyric); got ${fetchCalls.length}`);
    // Verify D1 was updated.
    const row = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sg-2'")
      .get() as { lyrics: string | null };
    assert(row.lyrics?.includes("External lyric") ?? false, "writes lyric back to song_masters.lyrics");
  }

  console.log("\ngetLyrics — D1 miss + external miss → 200 empty:");
  {
    fetchCalls = [];
    // search returns no songs at all
    fetchHandler = (call) => {
      if (call.url.includes("/api/search/get/web")) {
        return new Response(JSON.stringify({ result: { songs: [] } }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    };
    const sqlite = buildDb();
    // Use a title not in D1 to force the external path
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyrics?artist=Nobody&title=Nothing");
    assert(r.status === 200, "200 even when nothing found");
    const xml = await r.text();
    // Empty inner body: <lyrics artist="Nobody" title="Nothing"></lyrics>
    assert(xml.includes("<lyrics"), "lyrics element present");
    // toXML self-closes when there is no text body — both shapes are valid
    assert(
      /<lyrics[^>]*\/>/.test(xml) || /<lyrics[^>]*><\/lyrics>/.test(xml),
      "empty body when no lyric available (self-closing or empty pair)",
    );
  }

  console.log("\ngetLyrics — missing both params → 200 empty:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("UNEXPECTED", { status: 500 });
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyrics");
    assert(r.status === 200, "200 (Subsonic spec: empty <lyrics/>)");
    assert(fetchCalls.length === 0, "no external fetch when title omitted");
  }

  console.log("\ngetLyricsBySongId — D1 miss → external hit → lyricsList:");
  {
    fetchCalls = [];
    fetchHandler = neteaseHandler(123, "[00:00.00]Skyline\n[00:04.00]Falls down");
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyricsBySongId?id=sg-2");
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(xml.includes("<lyricsList"), "wraps in lyricsList");
    assert(xml.includes("<structuredLyrics"), "structuredLyrics element");
    assert(xml.includes('displayArtist="Adele"'), "artist display name from D1 join");
    assert(xml.includes('displayTitle="Skyfall"'), "title display from D1");
    assert(xml.includes("Skyline"), "lyric line 1 emitted");
    assert(xml.includes("Falls down"), "lyric line 2 emitted");
    assert(fetchCalls.length === 2, `search + lyric (got ${fetchCalls.length})`);
  }

  console.log("\ngetLyricsBySongId — unknown id → 404:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("UNEXPECTED", { status: 500 });
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyricsBySongId?id=sg-does-not-exist");
    assert(r.status === 404, `404 (got ${r.status})`);
    const xml = await r.text();
    assert(xml.includes('code="70"'), "Subsonic error code 70 (not found)");
    assert(fetchCalls.length === 0, "no external fetch when id unknown");
  }

  console.log("\ngetLyricsBySongId — missing id → 400:");
  {
    const sqlite = buildDb();
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyricsBySongId");
    assert(r.status === 400, `400 (got ${r.status})`);
  }

  console.log("\ngetLyricsBySongId — pre-populated lyrics_rich + enhanced=true → cueLine:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("UNEXPECTED", { status: 500 });
    const sqlite = buildDb();
    const richJson = JSON.stringify({
      tracks: [
        {
          kind: "main",
          lang: "ko",
          synced: true,
          line: [
            { start: 1000, value: "Hello" },
            { start: 2000, value: "world" },
          ],
          cueLine: [
            {
              index: 0,
              start: 1000,
              end: 2000,
              value: "Hello",
              cue: [
                { start: 1000, end: 1500, value: "Hel", byteStart: 0, byteEnd: 3 },
                { start: 1500, end: 2000, value: "lo", byteStart: 3, byteEnd: 5 },
              ],
            },
          ],
          agents: [],
        },
        {
          kind: "translation",
          lang: "en",
          synced: true,
          line: [
            { start: 1000, value: "Hi" },
            { start: 2000, value: "world" },
          ],
          cueLine: [],
          agents: [],
        },
      ],
    });
    sqlite.prepare("UPDATE song_masters SET lyrics_rich = ? WHERE id = 'sg-1'")
      .run(richJson);
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyricsBySongId?id=sg-1&enhanced=true");
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(xml.includes("<cueLine"), "cueLine element present");
    assert(xml.includes("<cue "), "cue element present");
    assert(xml.includes('byteStart="0"'), "byteStart attr");
    assert(xml.includes('kind="translation"'), "translation kind attr");
    assert(xml.includes('lang="ko"'), "main lang=ko");
    assert(xml.includes('lang="en"'), "translation lang=en");
    assert(fetchCalls.length === 0, "did NOT hit external fetch (lyrics_rich populated)");
  }

  console.log("\ngetLyricsBySongId — v1 (no enhanced) strips cueLine/kind:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response("UNEXPECTED", { status: 500 });
    const sqlite = buildDb();
    const richJson = JSON.stringify({
      tracks: [
        {
          kind: "main",
          lang: "ko",
          synced: true,
          line: [{ start: 1000, value: "Hello" }],
          cueLine: [
            {
              index: 0, start: 1000, end: 2000, value: "Hello",
              cue: [{ start: 1000, end: 1500, value: "Hel", byteStart: 0, byteEnd: 3 }],
            },
          ],
          agents: [],
        },
      ],
    });
    sqlite.prepare("UPDATE song_masters SET lyrics_rich = ? WHERE id = 'sg-1'")
      .run(richJson);
    const { get } = makeApp(sqlite);
    const r = await get("/rest/getLyricsBySongId?id=sg-1");
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(!xml.includes("<cueLine"), "no cueLine in v1 response");
    assert(!xml.includes("<cue "), "no cue in v1 response");
    assert(!xml.includes('kind="main"'), "no kind attr in v1 response (main is omitted)");
    assert(xml.includes("<line"), "line element still present");
    assert(xml.includes("Hello"), "line text still present");
  }

  restoreFetch();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
