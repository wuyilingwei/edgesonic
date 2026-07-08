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

// Task 076 — getCoverArt must NOT fall back to song-instance directory or
// embedded art when album.cover_r2_key is NULL.
//
// Background: the previous covers.resolveAlbumCover() path picked any
// cover.jpg / folder.jpg / front.jpg from the song's parent directory. When
// multiple albums shared a parent directory (e.g. NAS root) every album ended
// up writing distinct R2 keys whose *contents* were the same image — visually
// "hundreds of albums show the same anime character" even though 25 distinct
// keys exist in D1.
//
// Contract under test:
//   1. cover_r2_key NULL → 404 (no R2 puts, no body)
//   2. albums.cover_r2_key is NEVER updated by the request (fallback path off)
//   3. when cover_r2_key is set, the legacy 200 path still works
//
// Run: npx tsx test/cover_no_fallback.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../worker/src/endpoints/subsonic/media";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
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
  return { prepare, batch: async (s: unknown[]) => Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())) };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
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
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      image_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    -- song_instances exists so a stray covers.resolveAlbumCover call would
    -- still find something; we expect the new code to never reach it.
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT,
      artist_id TEXT,
      title TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT,
      source_id TEXT,
      storage_uri TEXT,
      suffix TEXT,
      missing INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );

    -- al-noart: would have triggered the fallback path
    INSERT INTO albums (id, name, cover_r2_key) VALUES ('al-noart', 'NoCover', NULL);
    INSERT INTO song_masters (id, album_id, title) VALUES ('sm-1', 'al-noart', 'T');
    INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, missing)
      VALUES ('si-1', 'sm-1', 'src-1', 'webdav://src-1/Artist/NoCover/01.mp3', 'mp3', 0);

    -- al-curated: admin set cover_r2_key, must still 200
    INSERT INTO albums (id, name, cover_r2_key) VALUES ('al-curated', 'Curated', 'covers/al-curated');
  `);
  return sqlite;
}

interface R2Entry { data: Uint8Array; contentType: string; }
interface R2Counter { get: string[]; put: string[]; }

function makeR2(initial: Record<string, R2Entry>, counter: R2Counter) {
  const map = new Map<string, R2Entry>(Object.entries(initial));
  return {
    async get(key: string) {
      counter.get.push(key);
      const v = map.get(key);
      if (!v) return null;
      return {
        async arrayBuffer() {
          return v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.byteLength);
        },
        get body() {
          return new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(v.data); c.close(); },
          });
        },
        writeHttpMetadata(h: Headers) { h.set("Content-Type", v.contentType); },
        size: v.data.length,
      };
    },
    async put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: { httpMetadata?: { contentType?: string } }) {
      counter.put.push(key);
      const ct = opts?.httpMetadata?.contentType || "application/octet-stream";
      const buf = body instanceof Uint8Array ? body : new Uint8Array(0);
      map.set(key, { data: buf, contentType: ct });
    },
    async head(key: string) { return map.has(key) ? { size: map.get(key)!.data.length } : null; },
    _map: map,
  };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  };
}

function makeApp(sqlite: DatabaseSync, r2: ReturnType<typeof makeR2>, kv: ReturnType<typeof makeKV>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any }>();
  app.route("/rest", mediaRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: r2, KV: kv };
  return {
    async get(url: string) {
      const req = new Request(`http://test${url}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

async function main() {
  console.log("getCoverArt(al-noart) with cover_r2_key NULL → 404 (no fallback):");
  {
    const counter: R2Counter = { get: [], put: [] };
    const r2 = makeR2({}, counter);
    const kv = makeKV();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-noart");
    assert(r.status === 404, `404 (got ${r.status})`);
    assert(counter.put.length === 0, "no R2 puts (no fallback wrote to covers/*)");
    // Critical: albums.cover_r2_key must remain NULL — the fallback path used
    // to UPDATE it with the wrongly-shared key, polluting future lookups.
    const row = sqlite.prepare("SELECT cover_r2_key FROM albums WHERE id = 'al-noart'").get() as { cover_r2_key: string | null };
    assert(row.cover_r2_key === null, "albums.cover_r2_key still NULL");
  }

  console.log("\ngetCoverArt(al-curated) with cover_r2_key set → 200 (happy path intact):");
  {
    const counter: R2Counter = { get: [], put: [] };
    const r2 = makeR2({
      "covers/al-curated": {
        data: new TextEncoder().encode("CURATED_BYTES"),
        contentType: "image/jpeg",
      },
    }, counter);
    const kv = makeKV();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-curated");
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(counter.get.includes("covers/al-curated"), "reads curated key from R2");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert(new TextDecoder().decode(bytes).includes("CURATED_BYTES"), "serves curated bytes");
  }

  console.log("\ngetCoverArt(al-missing) for non-existent album → 404:");
  {
    const counter: R2Counter = { get: [], put: [] };
    const r2 = makeR2({}, counter);
    const kv = makeKV();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-doesnotexist");
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
