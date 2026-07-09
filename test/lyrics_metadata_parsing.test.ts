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

//   A. worker/src/utils/tags.ts — embedded lyrics (ID3v2 USLT, FLAC vorbis
//      LYRICS/SYNCEDLYRICS/UNSYNCEDLYRICS) + disc number (TPOS/DISCNUMBER),
//      previously declared but never parsed.
//   B. worker/src/utils/metadataApply.ts — applyMetadataResult now persists
//      tags.lyrics to song_masters.lyrics (COALESCE-guarded: fills empty,
//      never overwrites), independent of the hasLogical/relink gate.
//   C. worker/src/endpoints/edgesonic/stats.ts — storage breakdown excludes
//      missing=1 song_instances rows (the R2-cost-includes-WebDAV-size bug).
//
// Run: npx tsx test/lyrics_metadata_parsing.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { parseTags } from "../worker/src/utils/tags";
import { applyMetadataResult } from "../worker/src/utils/metadataApply";
import { statsRoutes } from "../worker/src/endpoints/edgesonic/stats";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// Binary fixture builders (adapted from test/tagwrite.test.ts).
// ---------------------------------------------------------------------------
function syncsafeBytes(v: number): number[] {
  return [(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
}
function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
const enc = (s: string) => Array.from(new TextEncoder().encode(s));

function textFrame(id: string, text: string): number[] {
  const body = [0, ...enc(text)]; // enc=0
  return [...enc(id), ...be32Bytes(body.length), 0, 0, ...body];
}

// USLT frame: enc(0) + language(3) + descriptor(NUL) + lyrics text.
function usltFrame(lyrics: string, descriptor = ""): number[] {
  const body = [0, ...enc("eng"), ...enc(descriptor), 0, ...enc(lyrics)]; // enc=0 latin1-ish
  return [...enc("USLT"), ...be32Bytes(body.length), 0, 0, ...body];
}

function makeMp3(frames: number[]): Uint8Array {
  const tag = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafeBytes(frames.length), ...frames];
  const audio = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return new Uint8Array([...tag, ...audio]);
}

function makeFlac(comments: string[]): Uint8Array {
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  const block = (type: number, body: number[], last = false) =>
    [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const streaminfo = block(0, new Array(34).fill(0x11));
  const vendor = enc("testvendor");
  const kvs = comments.map(enc);
  const vcBody = [...le32(vendor.length), ...vendor, ...le32(kvs.length),
    ...kvs.flatMap((c) => [...le32(c.length), ...c])];
  const vc = block(4, vcBody);
  const padding = block(1, new Array(16).fill(0), true);
  const audio = [0xaa, 0xbb, 0xcc, 0xdd, 1, 2, 3, 4, 5];
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...streaminfo, ...vc, ...padding, ...audio]);
}

declare global { type D1Database = unknown; type Env = unknown; }

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
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return {
    prepare,
    batch: async (s: unknown[]) =>
      Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())),
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, song_count INTEGER DEFAULT 0, size INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT, artist_id TEXT, album_artist_id TEXT,
      title TEXT, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER,
      genre TEXT, lyrics TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL DEFAULT '',
      bit_rate INTEGER, sample_rate INTEGER, channels INTEGER, duration INTEGER,
      size INTEGER, missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    INSERT INTO artists (id, name) VALUES ('ar-1', 'Artist X');
    INSERT INTO albums (id, name) VALUES ('al-1', 'Album X');
    INSERT INTO song_masters (id, album_id, artist_id, title, lyrics) VALUES ('sm-1', 'al-1', 'ar-1', 'Song X', '');
    INSERT INTO song_instances (id, master_id, storage_uri) VALUES ('si-1', 'sm-1', 'r2://music/x.mp3');

    INSERT INTO song_masters (id, album_id, artist_id, title, lyrics) VALUES ('sm-2', 'al-1', 'ar-1', 'Song Y', 'already have real lyrics');
    INSERT INTO song_instances (id, master_id, storage_uri) VALUES ('si-2', 'sm-2', 'r2://music/y.mp3');
  `);
  return sqlite;
}

function buildStatsDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE albums (id TEXT PRIMARY KEY, cover_r2_key TEXT);
    -- getFeatureString(env, "r2_free_allocation_gb", "10") reads this table.
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'original', size INTEGER, missing INTEGER DEFAULT 0
    );
    -- Confirmed native R2 upload: 100 MB.
    INSERT INTO song_instances (id, master_id, storage_uri, source_type, size, missing)
      VALUES ('si-r2-ok', 'sm-1', 'r2://music/a.flac', 'original', 104857600, 0);
    -- A genuine WebDAV source row: 50 MB (the "real" library size on WebDAV).
    INSERT INTO song_instances (id, master_id, storage_uri, source_type, size, missing)
      VALUES ('si-webdav', 'sm-2', 'webdav://src-1/b.flac', 'original', 52428800, 0);
    -- Stuck hotcache claim: storage_uri already r2://..., size copied from the
    -- WebDAV source as a placeholder (200 MB), but missing=1 because the R2
    -- put never completed (Worker eviction / crash before cleanup ran).
    INSERT INTO song_instances (id, master_id, storage_uri, source_type, size, missing)
      VALUES ('si-stuck-claim', 'sm-3', 'r2://cache/webdav/sm-3.flac', 'cached', 209715200, 1);
    -- still excluded from the 'r2' bucket because source_type='cached' is a
    -- transient WebDAV play-through cache, not a native R2 upload. 30 MB.
    INSERT INTO song_instances (id, master_id, storage_uri, source_type, size, missing)
      VALUES ('si-hotcache-done', 'sm-4', 'r2://cache/webdav/sm-4.flac', 'cached', 31457280, 0);
  `);
  return sqlite;
}

function makeStatsApp(sqlite: DatabaseSync, level: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", { username: "admin", level }); return next(); });
  app.route("/", statsRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async get(url: string) {
      return app.fetch(new Request(`http://test${url}`), env);
    },
  };
}

async function main() {
  console.log("A. tags.ts — embedded lyrics + disc parsing");
  {
    const mp3 = makeMp3([
      ...textFrame("TIT2", "Song A"),
      ...textFrame("TPE1", "Artist A"),
      ...textFrame("TPOS", "2/3"),
      ...usltFrame("[00:00.00]line one\n[00:05.00]line two"),
    ]);
    const t = parseTags(mp3);
    assert(t?.title === "Song A", "ID3v2 title still parses alongside USLT/TPOS");
    assert(t?.disc === 2, "ID3v2 TPOS '2/3' -> disc=2");
    assert(t?.lyrics === "[00:00.00]line one\n[00:05.00]line two", "ID3v2 USLT -> lyrics text");
  }
  {
    // No title/artist/album at all — USLT alone must still make parseTags return
    // non-null (found=true from the USLT case), matching the read.ts contract.
    const mp3 = makeMp3([...usltFrame("just a lyric line")]);
    const t = parseTags(mp3);
    assert(t !== null && t.lyrics === "just a lyric line", "USLT-only file still parses (found=true)");
  }
  {
    const flac = makeFlac(["TITLE=Song B", "DISCNUMBER=1", "LYRICS=plain flac lyrics"]);
    const t = parseTags(flac);
    assert(t?.disc === 1, "FLAC DISCNUMBER -> disc=1");
    assert(t?.lyrics === "plain flac lyrics", "FLAC LYRICS vorbis comment -> lyrics");
  }
  {
    // SYNCEDLYRICS must win over LYRICS regardless of file order.
    const flac1 = makeFlac(["LYRICS=unsynced version", "SYNCEDLYRICS=[00:01.00]synced version"]);
    assert(parseTags(flac1)?.lyrics === "[00:01.00]synced version", "SYNCEDLYRICS wins when it comes after LYRICS");
    const flac2 = makeFlac(["SYNCEDLYRICS=[00:01.00]synced version", "LYRICS=unsynced version"]);
    assert(parseTags(flac2)?.lyrics === "[00:01.00]synced version", "SYNCEDLYRICS wins when it comes before LYRICS");
  }
  {
    const flac = makeFlac(["TITLE=Song C", "UNSYNCEDLYRICS=fallback lyrics"]);
    assert(parseTags(flac)?.lyrics === "fallback lyrics", "UNSYNCEDLYRICS used when no LYRICS/SYNCEDLYRICS present");
  }

  // -------------------------------------------------------------------------
  console.log("\nB. metadataApply.applyMetadataResult — lyrics persistence");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);

    // Lyrics-only submission (no title/artist/album/genre/year/track/disc) must
    // still be treated as "updated" and must persist lyrics — before 109 this
    // either 400'd (tag/submit.ts hasAnyLogical) or silently discarded the field
    // (metadataApply never wrote song_masters.lyrics at all).
    const res = await applyMetadataResult(db, "si-1", { lyrics: "[00:00.00]hello" }, {});
    assert(res.updated === true, "lyrics-only submission reports updated:true");
    const row1 = sqlite.prepare("SELECT lyrics, tag_scanned FROM song_masters sm JOIN song_instances si ON si.master_id = sm.id WHERE si.id = ?").get("si-1") as { lyrics: string };
    assert(row1.lyrics === "[00:00.00]hello", "lyrics persisted into empty song_masters.lyrics");
    const inst1 = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id = ?").get("si-1") as { tag_scanned: number };
    assert(inst1.tag_scanned === 1, "tag_scanned flips to 1 on lyrics-only submission");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);

    // sm-2 already has real lyrics — a lower-priority embedded-tag submission
    // must NOT clobber it (COALESCE(NULLIF(lyrics,''), ?) guard).
    await applyMetadataResult(db, "si-2", { lyrics: "embedded low-quality lyrics" }, {});
    const row2 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-2'").get() as { lyrics: string };
    assert(row2.lyrics === "already have real lyrics", "existing lyrics are never overwritten by a later scan");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);

    // Combined logical + lyrics submission: relink runs AND lyrics lands.
    await applyMetadataResult(db, "si-1", { title: "New Title", artist: "New Artist", lyrics: "combo lyrics" }, {});
    const row = sqlite.prepare("SELECT sm.title, sm.lyrics FROM song_masters sm WHERE sm.id = (SELECT master_id FROM song_instances WHERE id='si-1')").get() as { title: string; lyrics: string };
    assert(row.title === "New Title", "logical relink still runs when lyrics is also present");
    assert(row.lyrics === "combo lyrics", "lyrics also lands alongside a logical relink");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);

    // No lyrics at all in the payload — must not touch the lyrics column or throw.
    const res = await applyMetadataResult(db, "si-1", { title: "Only Title" }, {});
    assert(res.updated === true, "title-only submission still updates");
    const row = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-1'").get() as { lyrics: string };
    assert(row.lyrics === "", "absent lyrics field leaves the column untouched");
  }

  // -------------------------------------------------------------------------
  console.log("\nC. stats.ts — R2 breakdown excludes missing=1 rows + cached copies");
  {
    const sqlite = buildStatsDb();
    const { get } = makeStatsApp(sqlite, 3);
    const res = await get("/stats/storage");
    const body = await res.json() as { ok: boolean; breakdown: Array<{ source_type: string; count: number; bytes: number }> };
    assert(res.status === 200 && body.ok, "200 ok");
    const r2 = body.breakdown.find((r) => r.source_type === "r2");
    const webdav = body.breakdown.find((r) => r.source_type === "webdav");
    const cached = body.breakdown.find((r) => r.source_type === "cached");
    assert(r2?.bytes === 104857600, "r2 bucket only counts the native upload (100MB) — not the stuck claim or the completed hotcache copy");
    assert(r2?.count === 1, "r2 bucket count excludes both the stuck missing=1 claim and the completed cached row");
    assert(webdav?.bytes === 52428800, "webdav bucket unaffected (its own 50MB, not inflated by the stuck claim)");
    assert(cached?.bytes === 31457280, "110 — completed hotcache copy (missing=0) lands in its own 'cached' bucket, not 'r2'");
    assert(cached?.count === 1, "cached bucket count excludes the still-in-flight (missing=1) claim row");
    const totalBytes = body.breakdown.reduce((s, r) => s + r.bytes, 0);
    assert(totalBytes === 104857600 + 52428800 + 31457280, "stuck claim's 200MB placeholder never appears in ANY bucket total");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
