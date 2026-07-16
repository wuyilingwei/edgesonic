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

// asyncScanR2Source lists the native MUSIC_BUCKET binding directly (no S3
// credentials, no HTTP round-trip) and reuses the exact same skip/update/
// insert three-path structure as the WebDAV/S3 scanners, so existing r2://
// song_instances rows (native uploads AND hotcache-mirrored copies — both
// source_id='r2-local') are deduped by storage_uri instead of re-inserted.
//
// This test drives it against a real in-memory SQLite DB (node:sqlite) plus
// a stub MUSIC_BUCKET.list() so the INSERT OR IGNORE / ON CONFLICT / batch
// SQL actually executes instead of being pattern-matched by a hand-rolled
// mock.
//
// Run: npx tsx test/internal/r2_scan.test.ts

import { DatabaseSync } from "node:sqlite";
import { asyncScanR2Source } from "../../worker/src/endpoints/storage/scan";

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
      async first<T = unknown>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return {
    prepare,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async batch(stmts: any[]) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      root_path TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER, enabled INTEGER DEFAULT 1, mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, song_count INTEGER DEFAULT 0, size INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT, artist_id TEXT, title TEXT, sort_title TEXT, track INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT NOT NULL, source_type TEXT DEFAULT 'original',
      storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0,
      source_etag TEXT, source_last_modified INTEGER, tag_scanned INTEGER DEFAULT 0,
      missing INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, source_id TEXT, status TEXT DEFAULT 'running',
      total_items INTEGER DEFAULT 0, scanned_items INTEGER DEFAULT 0,
      started_at INTEGER, ended_at INTEGER, error_message TEXT
    );
    CREATE TABLE work_queue (id TEXT PRIMARY KEY);
  `);
  return sqlite;
}

interface StubObject { key: string; size: number; etag: string; uploaded: Date }
function makeBucket(objects: StubObject[], pageSize = 1000) {
  return {
    async list(opts: { cursor?: string; limit?: number }) {
      const limit = opts.limit ?? pageSize;
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const page = objects.slice(start, start + limit);
      const truncated = start + limit < objects.length;
      return {
        objects: page,
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
      };
    },
  };
}

// asyncScanR2Source only ever UPDATEs scan_jobs (mirroring asyncScanSource/
// asyncScanS3Source) — the row itself is inserted by the HTTP handler
// (startScanHandler, via queries.insertScanJob) before ctx.waitUntil fires.
// Reproduce that here so getScanJob-style assertions have a row to update.
function seedScanJob(sqlite: DatabaseSync, jobId: string, sourceId: string) {
  sqlite.prepare(
    `INSERT INTO scan_jobs (id, source_id, status, total_items, scanned_items, started_at) VALUES (?, ?, 'running', 0, 0, ?)`,
  ).run(jobId, sourceId, Math.floor(Date.now() / 1000));
}

async function main() {
  console.log("brand new bucket object → INSERT (artist/album/master/instance):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-1", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist A/Album A/01 Track One.mp3", size: 5000, etag: "e1", uploaded: new Date("2024-01-01T00:00:00Z") },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-1", {});
    const inst = sqlite.prepare("SELECT * FROM song_instances").all() as Array<{ storage_uri: string; source_id: string }>;
    assert(inst.length === 1, `exactly 1 instance inserted (got ${inst.length})`);
    assert(inst[0]?.storage_uri === "r2://music/Artist A/Album A/01 Track One.mp3", `bare-key r2:// uri (got ${inst[0]?.storage_uri})`);
    assert(inst[0]?.source_id === "r2-local", "source_id = r2-local");
    const job = sqlite.prepare("SELECT * FROM scan_jobs WHERE id='sj-1'").get() as { status: string; scanned_items: number; total_items: number };
    assert(job.status === "completed", `job completed (got ${job.status})`);
    assert(job.scanned_items === 1 && job.total_items === 1, "job counters = 1/1");
  }

  console.log("\nnon-audio keys (covers, sidecars) are ignored:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-2", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/cover.jpg", size: 100, etag: "e1", uploaded: new Date() },
      { key: "music/Artist/Album/track.lrc", size: 50, etag: "e2", uploaded: new Date() },
      { key: "music/Artist/Album/track.flac", size: 9000, etag: "e3", uploaded: new Date() },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-2", {});
    const inst = sqlite.prepare("SELECT storage_uri FROM song_instances").all() as Array<{ storage_uri: string }>;
    assert(inst.length === 1, `only the audio file inserted (got ${inst.length})`);
    assert(inst[0]?.storage_uri.endsWith("track.flac"), "the flac is the one that landed");
  }

  console.log("\nexisting instance with matching etag/size → SKIP (no UPDATE, tag_scanned untouched):");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    const lm = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, created_at, updated_at)
       VALUES ('si-1', 'sm-1', 'r2-local', 'r2://music/Artist/Album/track.mp3', 'mp3', 5000, 'e1', ?, 1, ?, ?)`,
    ).run(lm, now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-3", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/track.mp3", size: 5000, etag: "e1", uploaded: new Date("2024-01-01T00:00:00Z") },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-3", { etagCheck: true });
    const row = sqlite.prepare("SELECT tag_scanned, updated_at FROM song_instances WHERE id='si-1'").get() as { tag_scanned: number; updated_at: number };
    assert(row.tag_scanned === 1, "tag_scanned untouched (still 1) — file was skipped, not updated");
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM song_instances").get() as { n: number }).n;
    assert(count === 1, "no duplicate row created for the already-tracked key");
  }

  console.log("\nforce re-parse (etagCheck=false) → unchanged file still gets UPDATE + tag_scanned=0:");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    const lm = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, created_at, updated_at)
       VALUES ('si-1', 'sm-1', 'r2-local', 'r2://music/Artist/Album/track.mp3', 'mp3', 5000, 'e1', ?, 1, ?, ?)`,
    ).run(lm, now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-4", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/track.mp3", size: 5000, etag: "e1", uploaded: new Date("2024-01-01T00:00:00Z") },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-4", { etagCheck: false });
    const row = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id='si-1'").get() as { tag_scanned: number };
    assert(row.tag_scanned === 0, "tag_scanned reset to 0 by force re-parse");
  }

  console.log("\npre-existing row with NULL etag (native upload never recorded one) → first scan backfills it:");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, created_at, updated_at)
       VALUES ('si-1', 'sm-1', 'r2-local', 'r2://music/Artist/Album/track.mp3', 'mp3', 5000, NULL, NULL, 1, ?, ?)`,
    ).run(now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-5", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/track.mp3", size: 5000, etag: "e1", uploaded: new Date("2024-01-01T00:00:00Z") },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-5", { etagCheck: true });
    const row = sqlite.prepare("SELECT source_etag, tag_scanned FROM song_instances WHERE id='si-1'").get() as { source_etag: string; tag_scanned: number };
    assert(row.source_etag === "e1", "etag backfilled from the R2 object");
    assert(row.tag_scanned === 0, "backfill path resets tag_scanned (one-time reconciliation)");
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM song_instances").get() as { n: number }).n;
    assert(count === 1, "still exactly 1 row — no duplicate inserted");
  }

  console.log("\nsync_only mode: new object discovered but NOT inserted into song_instances:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-6", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/track.mp3", size: 5000, etag: "e1", uploaded: new Date() },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local", mode: "sync_only" }, "sj-6", {});
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM song_instances").get() as { n: number }).n;
    assert(count === 0, "sync_only never writes song_instances rows");
    const job = sqlite.prepare("SELECT scanned_items FROM scan_jobs WHERE id='sj-6'").get() as { scanned_items: number };
    assert(job.scanned_items === 1, "scan_jobs progress still counted the file though");
  }

  console.log("\npagination: objects spread across multiple list() pages are all scanned:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-7", "r2-local");
    const objects: StubObject[] = [];
    for (let i = 0; i < 5; i++) {
      objects.push({ key: `music/Artist/Album/track${i}.mp3`, size: 1000 + i, etag: `e${i}`, uploaded: new Date() });
    }
    const env = { MUSIC_BUCKET: makeBucket(objects, 2) }; // force 3 pages for 5 objects
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-7", {});
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM song_instances").get() as { n: number }).n;
    assert(count === 5, `all 5 objects across paginated list() calls landed (got ${count})`);
  }

  console.log("\nstorage_sources.last_sync upserts even when no real row exists yet (synthetic default):");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const before = sqlite.prepare("SELECT COUNT(*) AS n FROM storage_sources").get() as { n: number };
    assert(before.n === 0, "no storage_sources row before the scan");
    seedScanJob(sqlite, "sj-8", "r2-local");
    const env = { MUSIC_BUCKET: makeBucket([]) };
    await asyncScanR2Source(env, db, { id: "r2-local", mode: "library" }, "sj-8", {});
    const row = sqlite.prepare("SELECT last_sync, type FROM storage_sources WHERE id='r2-local'").get() as { last_sync: number; type: string } | undefined;
    assert(!!row, "a storage_sources row now exists for r2-local");
    assert(row?.type === "r2", `type=r2 (got ${row?.type})`);
    assert(!!row?.last_sync, "last_sync was set");

    // Second scan should NOT clobber a saved name via the upsert.
    sqlite.prepare("UPDATE storage_sources SET name = 'My Bucket' WHERE id = 'r2-local'").run();
    seedScanJob(sqlite, "sj-9", "r2-local");
    await asyncScanR2Source(env, db, { id: "r2-local", mode: "library" }, "sj-9", {});
    const row2 = sqlite.prepare("SELECT name FROM storage_sources WHERE id='r2-local'").get() as { name: string };
    assert(row2.name === "My Bucket", `saved name survives a later scan's upsert (got ${row2.name})`);
  }

  // 219 — scan never used to flip song_instances.missing when a file
  // disappeared from the source between scans (renames looked identical to
  // delete+create-elsewhere). The old row sat around forever with
  // missing=0, tag_scanned=0, and a dead storage_uri: work_queue kept
  // retrying its metadata task (permanent HTTP 404 → failed after 3
  // attempts) and listForMirror kept re-offering it to CrossCopy (which
  // also 404'd). Real-world case: a WebDAV "Epilogue" folder whose files
  // got renamed twice, leaving 4 zombie rows in production.
  console.log("\nfile removed from bucket → existing row flips missing=1:");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, missing, created_at, updated_at)
       VALUES ('si-gone', 'sm-gone', 'r2-local', 'r2://music/Artist/Album/gone.mp3', 'mp3', 5000, 'e1', ?, 0, 0, ?, ?)`,
    ).run(now, now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-10", "r2-local");
    // Bucket listing no longer contains gone.mp3 — only an unrelated file,
    // so audio.length > 0 and the scan is "complete" (no page-budget cutoff).
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/still-here.mp3", size: 1234, etag: "e9", uploaded: new Date() },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-10", { etagCheck: true });
    const row = sqlite.prepare("SELECT missing FROM song_instances WHERE id='si-gone'").get() as { missing: number };
    assert(row.missing === 1, `vanished file's row marked missing (got missing=${row.missing})`);
  }

  console.log("\nmissing row reappears in a later scan → missing flips back to 0:");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, missing, created_at, updated_at)
       VALUES ('si-back', 'sm-back', 'r2-local', 'r2://music/Artist/Album/back.mp3', 'mp3', 5000, 'e1', ?, 1, 1, ?, ?)`,
    ).run(now, now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-11", "r2-local");
    // Same etag/size as before it went missing — path 1's skip would
    // normally apply, but a missing=1 row must always fall through to the
    // path 2 UPDATE so the flag actually clears.
    const env = { MUSIC_BUCKET: makeBucket([
      { key: "music/Artist/Album/back.mp3", size: 5000, etag: "e1", uploaded: new Date() },
    ]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-11", { etagCheck: true });
    const row = sqlite.prepare("SELECT missing, tag_scanned FROM song_instances WHERE id='si-back'").get() as { missing: number; tag_scanned: number };
    assert(row.missing === 0, `resurrected file's row cleared back to missing=0 (got missing=${row.missing})`);
  }

  console.log("\nsuspiciously-empty listing does NOT mass-mark a populated source as missing:");
  {
    const sqlite = buildDb();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned, missing, created_at, updated_at)
       VALUES ('si-safe', 'sm-safe', 'r2-local', 'r2://music/Artist/Album/safe.mp3', 'mp3', 5000, 'e1', ?, 1, 0, ?, ?)`,
    ).run(now, now, now);
    const db = makeD1(sqlite);
    seedScanJob(sqlite, "sj-12", "r2-local");
    // list() reports zero objects — e.g. a transient auth hiccup that still
    // returns a "successful" empty page — while the DB already has rows.
    const env = { MUSIC_BUCKET: makeBucket([]) };
    await asyncScanR2Source(env, db, { id: "r2-local" }, "sj-12", { etagCheck: true });
    const row = sqlite.prepare("SELECT missing FROM song_instances WHERE id='si-safe'").get() as { missing: number };
    assert(row.missing === 0, `pre-existing row untouched by a suspiciously-empty listing (got missing=${row.missing})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
