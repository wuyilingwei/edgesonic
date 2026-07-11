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

// tables (song_masters / song_instances), and a backfill endpoint must replay
// older completed rows that were finished before the fix landed.
//
// Coverage:
//  1. submit metadata task → song_instances.tag_scanned=1 + physical params updated
//  2. song_masters relink artist_id/album_id (incl. brand-new artist/album)
//  3. format.bitrate / sampleRate / channels / duration land on song_instances
//  4. partial result (only some tag fields) — still flips tag_scanned, never throws
//  5. unknown instanceId in result → completed but applied.ok=false (no crash)
//  6. error path still works (no apply attempted)
//  7. /work/backfillCompleted: replays N pre-existing completed rows, returns
//    processed/applied/failed
//  8. helper directly: applyMetadataResult on an empty payload only flips
//    tag_scanned (no relink, no artist clobber)
//
// Run: npx tsx test/internal/work_submit_apply_metadata.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { workRoutes } from "../../worker/src/endpoints/edgesonic/work";
import { applyMetadataResult } from "../../worker/src/utils/metadataApply";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1Database shim backed by node:sqlite — same shape as submit_metadata.test.ts.
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
// Schema — work_queue + the business tables relinkArtistAlbum touches.
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      required_caps TEXT,
      priority INTEGER DEFAULT 5,
      status TEXT DEFAULT 'queued',
      claimed_by TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER,
      result_json TEXT,
      error_message TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      created_at INTEGER DEFAULT 0,
      expires_at INTEGER
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
      source_id TEXT,
      storage_uri TEXT NOT NULL,
      suffix TEXT,
      content_type TEXT,
      size INTEGER DEFAULT 0,
      bit_rate INTEGER DEFAULT 0,
      sample_rate INTEGER,
      channels INTEGER,
      duration INTEGER,
      missing INTEGER DEFAULT 0,
      tag_scanned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    -- ("dispatch_work"). Seed L3=enabled / L2=disabled to keep both the happy
    -- path and the "non-admin rejected" assertion behaving as before.
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (3, 'dispatch_work', 1, 0),
      (2, 'dispatch_work', 0, 0);

    -- Seed: one queued and one claimed task we will submit against.
    INSERT INTO artists (id, name) VALUES ('ar-old', 'Old Artist');
    INSERT INTO albums (id, name) VALUES ('al-old', 'Old Album');
    INSERT INTO song_masters (id, album_id, artist_id, title, track, duration)
      VALUES ('sg-1', 'al-old', 'ar-old', 'Song One', 1, 0);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, content_type, size, tag_scanned)
      VALUES ('inst-1', 'sg-1', 'r2://music/foo.m4a', 'm4a', 'audio/mp4', 5000000, 0);
  `);
  return sqlite;
}

function seedClaimed(sqlite: DatabaseSync, id: string, taskType: string, payload: unknown, claimer = "alice") {
  sqlite.prepare(
    `INSERT INTO work_queue (id, task_type, payload, status, claimed_by, claimed_at, heartbeat_at, attempts, max_attempts)
     VALUES (?, ?, ?, 'claimed', ?, 1000000000, 1000000000, 1, 3)`,
  ).run(id, taskType, JSON.stringify(payload), claimer);
}

function seedCompleted(sqlite: DatabaseSync, id: string, payload: unknown, result: unknown) {
  sqlite.prepare(
    `INSERT INTO work_queue (id, task_type, payload, status, result_json, attempts, max_attempts, created_at)
     VALUES (?, 'metadata', ?, 'completed', ?, 1, 3, ?)`,
  ).run(id, JSON.stringify(payload), JSON.stringify(result), Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------
// Hono harness — injects a user (alice / level 2 for /submit; admin / level 3
// for /backfillCompleted). Bypasses permissionMiddleware by mounting workRoutes
// at "/edgesonic" and pre-seeding c.var.user; permissionMiddleware is only on
// dispatch/poll which we don't exercise here.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/edgesonic", workRoutes);
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
  };
}

// ---------------------------------------------------------------------------
async function main() {

console.log("work/submit (metadata, success) → tag_scanned=1 + relink + physical params:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-metadata-inst-1", "metadata", { instanceId: "inst-1", sourceUri: "r2://music/foo.m4a", suffix: "m4a", size: 5000000 });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-metadata-inst-1",
    result: {
      instanceId: "inst-1",
      tags: {
        title: "Cosmic Drift",
        artist: "Nebula",
        album: "Arc",
        albumArtist: "Nebula",
        genre: "ambient",
        year: "2025",
        track: "3",
        disc: "1",
        duration: 210,
        bitrate: 320,
        sampleRate: 48000,
        channels: 2,
        container: "FLAC",
        codec: "FLAC",
      },
    },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.ok === true, "body.ok true");
  assert(body.status === "completed", "queue row marked completed");
  assert(body.applied?.ok === true, `applied.ok true (got ${JSON.stringify(body.applied)})`);
  assert(body.applied?.masterId === "sg-1", `masterId echoed (got ${body.applied?.masterId})`);

  // song_instances should be flipped
  const si = sqlite.prepare("SELECT * FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, `tag_scanned=1 (got ${si.tag_scanned})`);
  assert(si.bit_rate === 320, `bit_rate=320 (got ${si.bit_rate})`);
  assert(si.sample_rate === 48000, `sample_rate=48000 (got ${si.sample_rate})`);
  assert(si.channels === 2, `channels=2 (got ${si.channels})`);
  assert(si.duration === 210, `duration=210 (got ${si.duration})`);

  // song_masters should be relinked
  const sm = sqlite.prepare("SELECT * FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm.title === "Cosmic Drift", `title updated (got ${sm.title})`);
  assert(sm.track === 3, `track=3 (got ${sm.track})`);
  assert(sm.genre === "ambient", `genre updated (got ${sm.genre})`);
  assert(typeof sm.artist_id === "string" && sm.artist_id.startsWith("ar-") && sm.artist_id !== "ar-old", `artist_id relinked (got ${sm.artist_id})`);
  assert(typeof sm.album_id === "string" && sm.album_id.startsWith("al-") && sm.album_id !== "al-old", `album_id relinked (got ${sm.album_id})`);

  // brand-new artist + album rows exist
  const ar = sqlite.prepare("SELECT name FROM artists WHERE id=?").get(sm.artist_id) as any;
  const al = sqlite.prepare("SELECT name, year, genre FROM albums WHERE id=?").get(sm.album_id) as any;
  assert(ar?.name === "Nebula", `artist row created (got ${ar?.name})`);
  assert(al?.name === "Arc", `album row created (got ${al?.name})`);
  assert(al?.year === 2025, `album year populated (got ${al?.year})`);

  // queue row updated
  const wq = sqlite.prepare("SELECT status, result_json FROM work_queue WHERE id='wt-metadata-inst-1'").get() as any;
  assert(wq.status === "completed", `queue row status (got ${wq.status})`);
  assert(typeof wq.result_json === "string" && wq.result_json.includes("Cosmic Drift"), "result_json stored");
}

console.log("work/submit (metadata, partial tags) — still flips tag_scanned, no crash:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-metadata-inst-1", "metadata", { instanceId: "inst-1" });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-metadata-inst-1",
    result: {
      instanceId: "inst-1",
      tags: { bitrate: 192 },        // ONLY a physical field — no logical tags
    },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.applied?.ok === true, `applied.ok true (got ${JSON.stringify(body.applied)})`);

  const si = sqlite.prepare("SELECT * FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, "tag_scanned=1 even with only physical fields");
  assert(si.bit_rate === 192, `bit_rate=192 (got ${si.bit_rate})`);

  // song_masters must NOT have been clobbered with "Unknown Artist"
  const sm = sqlite.prepare("SELECT * FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm.title === "Song One", `title preserved (got ${sm.title})`);
  assert(sm.artist_id === "ar-old", `artist_id preserved (got ${sm.artist_id})`);
}

console.log("work/submit (metadata, unknown instanceId in result) — completed, applied.ok=false:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-metadata-ghost", "metadata", { instanceId: "inst-ghost" });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-metadata-ghost",
    result: { instanceId: "inst-ghost", tags: { title: "Lost" } },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.status === "completed", "queue row still completed");
  assert(body.applied?.ok === false, `applied.ok=false (got ${JSON.stringify(body.applied)})`);
  assert(/instance/i.test(body.applied?.reason || ""), `reason mentions instance (got ${body.applied?.reason})`);
}

console.log("work/submit (metadata, result.instanceId missing) — falls back to payload.instanceId:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-metadata-noid", "metadata", { instanceId: "inst-1" });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-metadata-noid",
    result: {
      // NO instanceId — older worker builds occasionally forget to echo it
      tags: { title: "Echo", artist: "Backstop" },
    },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.applied?.ok === true, `applied.ok via payload fallback (got ${JSON.stringify(body.applied)})`);
  const si = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, "tag_scanned=1 via payload-fallback path");
}

console.log("work/submit (error path) — no apply attempted:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-metadata-bad", "metadata", { instanceId: "inst-1" });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-metadata-bad",
    error: "decode failed",
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.status === "queued" || body.status === "failed", `error path status (got ${body.status})`);
  assert(body.applied === undefined, "no applied annotation on error path");

  // song_instances untouched
  const si = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 0, "tag_scanned untouched on error path");
}

console.log("work/submit (non-metadata task_type, e.g. transcode) — no apply attempted:");
{
  const sqlite = buildDb();
  seedClaimed(sqlite, "wt-transcode-1", "transcode", { instanceId: "inst-1", outputSuffix: "m4a" });
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/submit", {
    id: "wt-transcode-1",
    result: { r2Key: "out.m4a", size: 1234 },
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.status === "completed", "queue row completed");
  assert(body.applied === undefined, "no applied annotation for non-metadata task");
  // song_instances untouched
  const si = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 0, "tag_scanned untouched for transcode task");
}

console.log("work/backfillCompleted: replays multiple completed metadata rows:");
{
  const sqlite = buildDb();
  // Three pre-existing completed rows that never had their apply step run.
  seedCompleted(sqlite, "wt-old-1", { instanceId: "inst-1" }, {
    instanceId: "inst-1",
    tags: { title: "Backfilled", artist: "Hist", album: "Past", bitrate: 128 },
  });
  // Second row references the SAME instance — second apply re-runs the relink
  // (idempotent — md5 of the same artist/album hashes yields the same id).
  seedCompleted(sqlite, "wt-old-2", { instanceId: "inst-1" }, {
    instanceId: "inst-1",
    tags: { title: "Backfilled v2", artist: "Hist", album: "Past", bitrate: 160 },
  });
  // Third row points at a non-existent instance — failure path.
  seedCompleted(sqlite, "wt-old-3", { instanceId: "inst-ghost" }, {
    instanceId: "inst-ghost",
    tags: { title: "Lost" },
  });

  const { post } = makeApp(sqlite, { username: "root", level: 3 });
  const r = await post("/edgesonic/work/backfillCompleted", {});
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as any;
  assert(body.processed === 3, `processed=3 (got ${body.processed})`);
  assert(body.applied === 2, `applied=2 (got ${body.applied})`);
  assert(body.failed === 1, `failed=1 (got ${body.failed})`);
  assert(Array.isArray(body.errors) && body.errors.length === 1, `errors[] populated (got ${body.errors?.length})`);

  // Confirm the apply actually wrote
  const si = sqlite.prepare("SELECT tag_scanned, bit_rate FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, `tag_scanned=1 after backfill (got ${si.tag_scanned})`);
  // Last applied row's bitrate wins — backfill processes in created_at ASC order
  assert(si.bit_rate === 160, `bit_rate=160 (last apply wins, got ${si.bit_rate})`);
}

console.log("work/backfillCompleted: non-admin rejected:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite, { username: "alice", level: 2 });
  const r = await post("/edgesonic/work/backfillCompleted", {});
  assert(r.status === 403, `403 status (got ${r.status})`);
}

console.log("applyMetadataResult (helper, empty payload) → only tag_scanned flips, no relink:");
{
  const sqlite = buildDb();
  const db = makeD1(sqlite);
  const r = await applyMetadataResult(db, "inst-1", {}, {});
  assert(r.updated === true, "updated=true even with empty payload");
  assert(r.masterId === "sg-1", `masterId echoed (got ${r.masterId})`);
  const si = sqlite.prepare("SELECT tag_scanned FROM song_instances WHERE id='inst-1'").get() as any;
  assert(si.tag_scanned === 1, "tag_scanned=1");
  const sm = sqlite.prepare("SELECT title, artist_id FROM song_masters WHERE id='sg-1'").get() as any;
  assert(sm.title === "Song One", "title preserved (no relink)");
  assert(sm.artist_id === "ar-old", "artist_id preserved (no Unknown Artist clobber)");
}

console.log("applyMetadataResult (helper, missing instanceId) → reason='missing instanceId':");
{
  const sqlite = buildDb();
  const db = makeD1(sqlite);
  const r = await applyMetadataResult(db, "", {}, {});
  assert(r.updated === false, "updated=false");
  assert(r.reason === "missing instanceId", `reason (got ${r.reason})`);
}

// ---------------------------------------------------------------------------
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => { console.error(err); process.exit(1); },
);
