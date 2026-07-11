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

// browser-pool re-check that (A) hands song_instances the worker's embedded
// parser couldn't read (tag_scanned=2 — unsupported container format or a
// broken file) to the browser pool, (B) backfills lyrics/disc on already
// -scanned songs whose album already has a cover, and (C) re-checks WAV files
// whose duration looks like a pre-111 truncated-buffer scan artifact.
//
// Run: npx tsx test/metadata_recheck.test.ts

import { DatabaseSync } from "node:sqlite";
import { runMetadataRecheck, maybeRunMetadataRecheck } from "../worker/src/utils/metadataRecheck";

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
  return {
    prepare,
    batch: async (s: unknown[]) =>
      Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())),
  };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, cover_r2_key TEXT);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT, lyrics TEXT, disc INTEGER, duration INTEGER);
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL,
      suffix TEXT, size INTEGER, missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0
    );
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued', max_attempts INTEGER NOT NULL DEFAULT 3,
      expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- (A) unsupported format / worker-parser gave up: tag_scanned=2.
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-1', NULL);
    INSERT INTO song_masters (id, album_id, lyrics, disc) VALUES ('sm-1', 'al-1', NULL, NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-unsupported', 'sm-1', 'r2://music/a.m4a', 'm4a', 1000, 0, 2);

    -- (B) scanned ok, cover present, but lyrics AND disc still empty.
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-2', 'al-2-cover.jpg');
    INSERT INTO song_masters (id, album_id, lyrics, disc) VALUES ('sm-2', 'al-2', '', NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-incomplete', 'sm-2', 'r2://music/b.flac', 'flac', 2000, 0, 1);

    -- Fully complete: scanned, cover present, lyrics AND disc both filled
    -- must NOT be selected by either criterion.
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-3', 'al-3-cover.jpg');
    INSERT INTO song_masters (id, album_id, lyrics, disc) VALUES ('sm-3', 'al-3', 'la la la', 1);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-complete', 'sm-3', 'r2://music/c.flac', 'flac', 3000, 0, 1);

    -- Scanned, lyrics empty, but album has NO cover yet — pipeline hasn't
    -- really finished with this one; must NOT be selected by criterion B
    -- (that's what "封面不缺失" gates on).
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-4', NULL);
    INSERT INTO song_masters (id, album_id, lyrics, disc) VALUES ('sm-4', 'al-4', '', NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-no-cover-yet', 'sm-4', 'r2://music/d.flac', 'flac', 4000, 0, 1);

    -- missing=1 row that would otherwise match criterion A — must be excluded.
    INSERT INTO song_masters (id, album_id, lyrics, disc) VALUES ('sm-5', 'al-1', NULL, NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-gone', 'sm-5', 'r2://music/e.m4a', 'm4a', 5000, 1, 2);

    -- pattern (pre-111 truncated-buffer scan). lyrics/disc filled so it must
    -- NOT also match criterion B — only C.
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-6', 'al-6-cover.jpg');
    INSERT INTO song_masters (id, album_id, lyrics, disc, duration) VALUES ('sm-6', 'al-6', 'la la la', 1, 3);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-bad-wav-duration', 'sm-6', 'r2://music/f.wav', 'wav', 35223552, 0, 1);

    -- A genuinely short WAV (small file, plausible few-second duration) must
    -- NOT be flagged — the size floor guards against false positives.
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-7', 'al-7-cover.jpg');
    INSERT INTO song_masters (id, album_id, lyrics, disc, duration) VALUES ('sm-7', 'al-7', 'la la la', 1, 3);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-short-wav-ok', 'sm-7', 'r2://music/g.wav', 'wav', 200000, 0, 1);

    -- A large FLAC with duration=3 must NOT be flagged — criterion C is
    -- suffix='wav' only (FLAC's own truncation math differs; not the bug
    -- 111 fixed, and misclassifying it would waste a re-check).
    INSERT INTO albums (id, cover_r2_key) VALUES ('al-8', 'al-8-cover.jpg');
    INSERT INTO song_masters (id, album_id, lyrics, disc, duration) VALUES ('sm-8', 'al-8', 'la la la', 1, 3);
    INSERT INTO song_instances (id, master_id, storage_uri, suffix, size, missing, tag_scanned)
      VALUES ('si-short-flac', 'sm-8', 'r2://music/h.flac', 'flac', 35223552, 0, 1);
  `);
  return sqlite;
}

async function main() {
  console.log("A/B/C candidate selection + dedup namespaces:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const result = await runMetadataRecheck(db);
    assert(result.unsupportedFormat === 1, `criterion A matched exactly 1 row (got ${result.unsupportedFormat})`);
    assert(result.lyricsOrDiscIncomplete === 1, `criterion B matched exactly 1 row (got ${result.lyricsOrDiscIncomplete})`);
    assert(result.implausibleWavDuration === 1, `criterion C matched exactly 1 row (got ${result.implausibleWavDuration})`);
    assert(result.dispatched === 3, `3 total dispatched (got ${result.dispatched})`);

    const queued = sqlite.prepare("SELECT id, task_type, payload FROM work_queue ORDER BY id").all() as
      Array<{ id: string; task_type: string; payload: string }>;
    assert(queued.length === 3, `exactly 3 work_queue rows created (got ${queued.length})`);
    assert(queued.every((r) => r.task_type === "metadata"), "all rows are task_type=metadata");
    assert(queued.some((r) => r.id === "wt-metadata-recheck:si-unsupported"), "si-unsupported gets the recheck: dedup namespace id");
    assert(queued.some((r) => r.id === "wt-metadata-recheck:si-incomplete"), "si-incomplete gets the recheck: dedup namespace id");
    assert(queued.some((r) => r.id === "wt-metadata-recheck-dur:si-bad-wav-duration"), "si-bad-wav-duration gets the recheck-dur: dedup namespace id");
    assert(!queued.some((r) => r.id.includes("si-complete")), "fully-complete song never dispatched");
    assert(!queued.some((r) => r.id.includes("si-no-cover-yet")), "lyrics-empty-but-no-cover song never dispatched (cover gate)");
    assert(!queued.some((r) => r.id.includes("si-gone")), "missing=1 row never dispatched even though tag_scanned=2");
    assert(!queued.some((r) => r.id.includes("si-short-wav-ok")), "small genuinely-short WAV never dispatched (size floor guard)");
    assert(!queued.some((r) => r.id.includes("si-short-flac")), "short-duration FLAC never dispatched (criterion C is WAV-only)");

    const payload = JSON.parse(queued.find((r) => r.id.includes("si-unsupported"))!.payload);
    assert(payload.instanceId === "si-unsupported", "payload carries instanceId");
    assert(payload.sourceUri === "r2://music/a.m4a", "payload carries sourceUri (052a wire shape)");
    assert(payload.suffix === "m4a", "payload carries suffix");
  }
  {
    // Re-running must be a no-op (INSERT OR IGNORE on both dedup namespaces)
    // — these instances should never be re-dispatched by this mechanism again.
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    await runMetadataRecheck(db);
    await runMetadataRecheck(db);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 3, `re-running twice still yields exactly 3 rows, not 6 (got ${count})`);
  }
  {
    // A scan.ts-style plain dedupKey ("<instanceId>", no namespace) must NOT
    // block this mechanism from ALSO dispatching a "recheck:<instanceId>" row
    // for the same instance — the whole point is to re-offer already-scanned
    // instances a second pass.
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.exec(`
      INSERT INTO work_queue (id, task_type, payload, priority, status, max_attempts)
      VALUES ('wt-metadata-si-incomplete', 'metadata', '{}', 5, 'completed', 3);
    `);
    await runMetadataRecheck(db);
    const recheckRow = sqlite.prepare("SELECT id FROM work_queue WHERE id = 'wt-metadata-recheck:si-incomplete'").get();
    assert(recheckRow !== undefined, "recheck: namespace dispatch succeeds even though a plain scan.ts dedup row already exists for the same instance");
  }
  {
    // An instance already re-checked under A/B ("recheck:" namespace, from
    // before 111 existed) must still be eligible for the separate "recheck-dur:"
    // namespace — the whole reason C uses its own prefix.
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.exec(`
      INSERT INTO work_queue (id, task_type, payload, priority, status, max_attempts)
      VALUES ('wt-metadata-recheck:si-bad-wav-duration', 'metadata', '{}', 5, 'completed', 3);
    `);
    await runMetadataRecheck(db);
    const durRow = sqlite.prepare("SELECT id FROM work_queue WHERE id = 'wt-metadata-recheck-dur:si-bad-wav-duration'").get();
    assert(durRow !== undefined, "recheck-dur: namespace dispatch succeeds even though a recheck: row already exists for the same instance");
  }

  console.log("\nmaybeRunMetadataRecheck — cadence gate:");
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('metadata_recheck_interval_hours', '0')");
    await maybeRunMetadataRecheck({ DB: db } as never, {} as never);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 0, "interval=0 disables the check entirely — nothing dispatched");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('metadata_recheck_interval_hours', '24')");
    sqlite.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES ('cron:last_metadata_recheck_ts', ?, ?)").run(String(now - 3600), now - 3600);
    await maybeRunMetadataRecheck({ DB: db } as never, {} as never);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 0, "last run 1h ago, interval 24h — not yet due, nothing dispatched");
  }
  {
    const sqlite = buildDb();
    const db = makeD1(sqlite);
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('metadata_recheck_interval_hours', '24')");
    sqlite.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES ('cron:last_metadata_recheck_ts', ?, ?)").run(String(now - 25 * 3600), now - 25 * 3600);
    await maybeRunMetadataRecheck({ DB: db } as never, {} as never);
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM work_queue").get() as { n: number }).n;
    assert(count === 3, `last run 25h ago, interval 24h — due, dispatches all 3 candidates (got ${count})`);
    const stamped = sqlite.prepare("SELECT value FROM kv_store WHERE key = 'cron:last_metadata_recheck_ts'").get() as { value: string };
    assert(Number(stamped.value) >= now, "last-run timestamp advances to (approximately) now");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
