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

// 042 — POST /rest/tidyFolder tests.
//
// Uses the same in-memory D1 shim as test/batch_write_tags.test.ts but also
// stubs `env.MUSIC_BUCKET` so we can observe put + delete calls. WebDAV is
// covered with a stubbed global fetch tracking MOVE requests.
//
// Run: npx tsx test/tidy_folder.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { tidyFolderRoutes, renderTemplate } from "../worker/src/endpoints/tag/tidy";

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

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
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
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT NOT NULL,
      storage_uri TEXT NOT NULL,
      suffix TEXT,
      content_type TEXT,
      size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      duration INTEGER,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY,
      type TEXT,
      base_url TEXT,
      username TEXT,
      password TEXT,
      presign_username TEXT,
      presign_password TEXT,
      root_path TEXT,
      enabled INTEGER DEFAULT 1
    );

    INSERT INTO user_permissions VALUES (2, 'manage_files', 1, 0);
    INSERT INTO artists (id, name) VALUES ('ar-rad', 'Radiohead');
    INSERT INTO albums (id, name, year) VALUES ('al-okc', 'OK Computer', 1997);
    INSERT INTO song_masters (id, album_id, artist_id, title, track) VALUES ('sg-air', 'al-okc', 'ar-rad', 'Airbag', 1);
    INSERT INTO song_masters (id, album_id, artist_id, title, track) VALUES ('sg-par', 'al-okc', 'ar-rad', 'Paranoid Android', 2);

    -- R2 instance under music/legacy/...
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type)
      VALUES ('inst-air-r2', 'sg-air', 'r2://music/legacy/Airbag.mp3', 'mp3', 'audio/mpeg');
    -- WebDAV instance (uses sourceId 'wd1')
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type)
      VALUES ('inst-par-wd', 'sg-par', 'webdav://wd1/music/Paranoid.flac', 'flac', 'audio/flac');
    -- read-only source (subsonic)
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type)
      VALUES ('inst-par-sub', 'sg-par', 'subsonic://upstream/123', 'mp3', 'audio/mpeg');

    INSERT INTO storage_sources (id, type, base_url, username, password, root_path, enabled)
      VALUES ('wd1', 'webdav', 'https://dav.example.com', 'u', 'p', '', 1);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Fake R2 bucket — records puts + deletes.
// ---------------------------------------------------------------------------
function makeBucket() {
  const objects = new Map<string, { body: any; httpMetadata: any; customMetadata: any }>();
  objects.set("music/legacy/Airbag.mp3", { body: new Uint8Array([1, 2, 3]), httpMetadata: { contentType: "audio/mpeg" }, customMetadata: {} });
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    bucket: {
      async get(key: string) {
        return objects.get(key) ?? null;
      },
      async put(key: string, body: any, opts?: any) {
        puts.push(key);
        objects.set(key, { body, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
      },
      async delete(key: string) {
        deletes.push(key);
        objects.delete(key);
      },
    },
    puts,
    deletes,
    objects,
  };
}

function makeApp(sqlite: DatabaseSync, bucket: any) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 2, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/tag", tidyFolderRoutes);
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: bucket };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
  };
}

async function main() {

console.log("renderTemplate placeholders:");
{
  const ctx = { title: "Airbag", artist: "Radiohead", albumArtist: "Radiohead", album: "OK Computer", year: "1997", track: 1 };
  assert(
    renderTemplate("{albumArtist}/{album}/{track:02d} - {title}", ctx) === "Radiohead/OK Computer/01 - Airbag",
    "zero-padded track + slashes",
  );
  assert(
    renderTemplate("{year}/{artist} - {title}", ctx) === "1997/Radiohead - Airbag",
    "year + artist placeholder",
  );
  // sanitisation: forbidden chars become underscore
  const bad = { ...ctx, title: "a/b:c?", album: "x<y>z" };
  const r = renderTemplate("{album}/{title}", bad);
  assert(!r.includes("/b") && !r.includes("?") && !r.includes("<"), `forbidden chars stripped (got ${r})`);
  // empty placeholders don't leave double slashes
  const noYear = { ...ctx, year: "" };
  assert(renderTemplate("{year}/{title}", noYear) === "Airbag", "empty placeholder collapsed");
}

console.log("dry run: returns planned without touching the bucket:");
{
  const sqlite = buildDb();
  const { bucket, puts, deletes } = makeBucket();
  const { post } = makeApp(sqlite, bucket);
  const r = await post("/tag/tidyFolder", {
    template: "{albumArtist}/{album}/{track:02d} - {title}",
    ids: ["sg-air"],
    dryRun: true,
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true && body.dryRun === true, "ok + dryRun echoed");
  assert(Array.isArray(body.planned) && body.planned.length === 1, "one planned row");
  assert(
    body.planned[0].to === "r2://music/Radiohead/OK Computer/01 - Airbag.mp3",
    `planned to-uri (got ${body.planned[0].to})`,
  );
  assert(puts.length === 0 && deletes.length === 0, "no bucket ops");
  assert((body.applied || []).length === 0, "no applied rows on dry run");
}

console.log("happy path: R2 move applied:");
{
  const sqlite = buildDb();
  const { bucket, puts, deletes } = makeBucket();
  const { post } = makeApp(sqlite, bucket);
  const r = await post("/tag/tidyFolder", {
    template: "{albumArtist}/{album}/{track:02d} - {title}",
    ids: ["sg-air"],
  });
  const body = await r.json() as any;
  assert(r.status === 200 && body.ok === true, "200 ok");
  assert(body.failed === 0, `failed=0 (got ${body.failed})`);
  assert(puts.length === 1, `one put (got ${puts.length})`);
  assert(puts[0] === "music/Radiohead/OK Computer/01 - Airbag.mp3", `put key (got ${puts[0]})`);
  assert(deletes.length === 1 && deletes[0] === "music/legacy/Airbag.mp3", "old key deleted");

  // D1 reflects the new URI
  const row = sqlite.prepare("SELECT storage_uri FROM song_instances WHERE id = 'inst-air-r2'").get() as any;
  assert(
    row.storage_uri === "r2://music/Radiohead/OK Computer/01 - Airbag.mp3",
    `storage_uri updated (got ${row.storage_uri})`,
  );
}

console.log("read-only source produces a skipped entry, not a failure:");
{
  const sqlite = buildDb();
  const { bucket, puts, deletes } = makeBucket();
  const { post } = makeApp(sqlite, bucket);
  const r = await post("/tag/tidyFolder", {
    template: "{album}/{title}",
    ids: ["sg-par"],
    source: "r2",            // filter excludes both webdav + subsonic instances
  });
  const body = await r.json() as any;
  assert(body.ok === true, "ok true");
  assert(body.planned.length === 0, `no planned rows when filtering r2 with no r2 inst (got ${body.planned.length})`);
  assert(puts.length === 0 && deletes.length === 0, "no bucket ops");
}

console.log("subsonic instance reports skipped reason when no filter:");
{
  const sqlite = buildDb();
  const { bucket } = makeBucket();
  const { post } = makeApp(sqlite, bucket);
  const r = await post("/tag/tidyFolder", {
    template: "{album}/{title}",
    ids: ["sg-par"],
    dryRun: true,
  });
  const body = await r.json() as any;
  const subPlan = body.planned.find((p: any) => p.from.startsWith("subsonic://"));
  assert(!!subPlan && /read-only/i.test(subPlan.skipped || ""), `subsonic marked read-only (got ${subPlan?.skipped})`);
  const wdPlan = body.planned.find((p: any) => p.from.startsWith("webdav://"));
  assert(!!wdPlan && wdPlan.to.startsWith("webdav://wd1/"), `webdav planned with correct uri (got ${wdPlan?.to})`);
}

console.log("WebDAV MOVE happy path (stubbed fetch):");
{
  const sqlite = buildDb();
  const { bucket } = makeBucket();
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = typeof url === "string" ? url : url.url;
    calls.push({ url: u, method: init?.method || "GET", headers: init?.headers || {} });
    return new Response("", { status: 201 });
  }) as typeof fetch;
  try {
    const { post } = makeApp(sqlite, bucket);
    const r = await post("/tag/tidyFolder", {
      template: "{albumArtist}/{album}/{track:02d} - {title}",
      ids: ["sg-par"],
      source: "webdav",
    });
    const body = await r.json() as any;
    assert(body.ok === true && body.failed === 0, `ok / no failures (got ${body.failed})`);
    const move = calls.find((c) => c.method === "MOVE");
    assert(!!move, "MOVE was called");
    if (move) {
      assert(move.url.includes("Paranoid.flac"), `MOVE on the old path (got ${move.url})`);
      assert(
        typeof move.headers.Destination === "string" && move.headers.Destination.includes("Paranoid%20Android.flac"),
        `Destination header set (got ${move.headers.Destination})`,
      );
    }
    const row = sqlite.prepare("SELECT storage_uri FROM song_instances WHERE id = 'inst-par-wd'").get() as any;
    assert(row.storage_uri.includes("Paranoid Android.flac"), `D1 row updated (got ${row.storage_uri})`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("validation errors:");
{
  const sqlite = buildDb();
  const { bucket } = makeBucket();
  const { post } = makeApp(sqlite, bucket);

  const r1 = await post("/tag/tidyFolder", { template: "x/{title}" });
  assert(r1.status === 400, `missing ids → 400 (got ${r1.status})`);

  const r2 = await post("/tag/tidyFolder", { template: "", ids: ["sg-air"] });
  assert(r2.status === 400, `empty template → 400 (got ${r2.status})`);

  const r3 = await post("/tag/tidyFolder", { template: "x/{title}", ids: [] });
  assert(r3.status === 400, `empty ids → 400 (got ${r3.status})`);

  const r4 = await post("/tag/tidyFolder", { template: "x/{title}", ids: ["sg-ghost"] });
  const b4 = await r4.json() as any;
  assert(b4.failed === 1, `ghost id counted as failure (got ${b4.failed})`);
  const ghost = b4.applied.find((a: any) => a.id === "sg-ghost");
  assert(ghost && /not found/i.test(ghost.error), "ghost reports not found");
}

}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => { console.error(err); process.exit(1); },
);
