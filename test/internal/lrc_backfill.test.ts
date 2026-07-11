// 113 — Batch LRC sidecar backfill (worker/src/utils/lrcBackfill.ts).
//
// Coverage:
//   1. runLrcBackfill fills lyrics for a candidate whose sibling .lrc exists
//      in the (mocked) R2 bucket.
//   2. A candidate with no sidecar stays a candidate (lyrics still empty,
//      counted in `candidates` but not `filled`).
//   3. Songs that already have lyrics are excluded from selection entirely.
//   4. Instances with source_type != 'original' (cached/transcoded) are
//      excluded — their storage_uri points at a synthetic cache path with no
//      meaningful sibling file.
//   5. maybeRunLrcBackfill respects lrc_backfill_interval_hours=0 (disabled)
//      and the kv_store cadence throttle (won't re-run within the window).
//
// Run: npx tsx test/internal/lrc_backfill.test.ts

import { DatabaseSync } from "node:sqlite";
import { runLrcBackfill, maybeRunLrcBackfill } from "../../worker/src/utils/lrcBackfill";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

// ---------------------------------------------------------------------------
// D1 shim (same shape as the rest of the suite)
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
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', lyrics TEXT,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'original', missing INTEGER DEFAULT 0
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE kv_store (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0
    );

    -- sm-1: has a sidecar .lrc waiting in the mock bucket → should fill.
    INSERT INTO song_masters (id, title, lyrics) VALUES ('sm-1', 'Has Sidecar', NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, source_type)
      VALUES ('si-1', 'sm-1', 'r2://music/Artist/Album/01 Has Sidecar.flac', 'original');

    -- sm-2: no sidecar in the bucket → stays a candidate, not filled.
    INSERT INTO song_masters (id, title, lyrics) VALUES ('sm-2', 'No Sidecar', NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, source_type)
      VALUES ('si-2', 'sm-2', 'r2://music/Artist/Album/02 No Sidecar.flac', 'original');

    -- sm-3: already has lyrics → excluded from selection entirely.
    INSERT INTO song_masters (id, title, lyrics) VALUES ('sm-3', 'Already Has Lyrics', 'la la la');
    INSERT INTO song_instances (id, master_id, storage_uri, source_type)
      VALUES ('si-3', 'sm-3', 'r2://music/Artist/Album/03 Already Has Lyrics.flac', 'original');

    -- sm-4: only a 'cached' (non-original) instance whose synthetic path
    -- happens to have a sidecar hit registered in the mock bucket — must be
    -- excluded by the source_type filter regardless.
    INSERT INTO song_masters (id, title, lyrics) VALUES ('sm-4', 'Cached Only', NULL);
    INSERT INTO song_instances (id, master_id, storage_uri, source_type)
      VALUES ('si-4', 'sm-4', 'r2://cache/webdav/sm-4.flac', 'cached');
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Minimal R2Bucket mock — only what createR2Adapter().stream()/fetchLrcSidecar
// touch: get(key) → object with .body/.size/.httpMetadata, or null (404).
// ---------------------------------------------------------------------------
function textToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeBucket(files: Record<string, string>) {
  return {
    async get(key: string) {
      const text = files[key];
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      return {
        body: textToStream(text),
        size: bytes.byteLength,
        httpMetadata: { contentType: "text/plain" },
      };
    },
  };
}

interface Env { DB: unknown; MUSIC_BUCKET: unknown }

function makeEnv(sqlite: DatabaseSync, files: Record<string, string>): Env {
  return { DB: makeD1(sqlite), MUSIC_BUCKET: makeBucket(files) };
}

async function main() {
  console.log("runLrcBackfill — fills, skips-no-sidecar, excludes has-lyrics/non-original:");
  {
    const sqlite = buildDb();
    const env = makeEnv(sqlite, {
      "music/Artist/Album/01 Has Sidecar.lrc": "[00:00.00]la la la",
      // sm-4's cache path deliberately has a sidecar too — proves the
      // source_type filter (not just "no file present") is what excludes it.
      "cache/webdav/sm-4.lrc": "[00:00.00]should never be read",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runLrcBackfill(env.DB as any, env as any);
    // sm-4 is excluded by the SQL WHERE (source_type='original') before we
    // ever get to fetchLrcSidecar, so it never counts as a candidate at all.
    assert(result.candidates === 2, `2 candidates selected (sm-1, sm-2) — got ${result.candidates}`);
    assert(result.filled === 1, `1 filled (sm-1 only) — got ${result.filled}`);

    const sm1 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-1'").get() as { lyrics: string };
    assert(sm1.lyrics === "[00:00.00]la la la", `sm-1 lyrics filled (got '${sm1.lyrics}')`);

    const sm2 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-2'").get() as { lyrics: string | null };
    assert(sm2.lyrics === null, "sm-2 lyrics still null (no sidecar found)");

    const sm3 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-3'").get() as { lyrics: string };
    assert(sm3.lyrics === "la la la", "sm-3 untouched (already had lyrics, never selected)");

    const sm4 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-4'").get() as { lyrics: string | null };
    assert(sm4.lyrics === null, "sm-4 lyrics still null (cached instance excluded by source_type filter)");
  }

  console.log("\nmaybeRunLrcBackfill — disabled (0) is a no-op:");
  {
    const sqlite = buildDb();
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('lrc_backfill_interval_hours', '0')");
    const env = makeEnv(sqlite, { "music/Artist/Album/01 Has Sidecar.lrc": "[00:00.00]la la la" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeRunLrcBackfill(env as any, { waitUntil: () => {} } as any);
    const sm1 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-1'").get() as { lyrics: string | null };
    assert(sm1.lyrics === null, "sm-1 untouched — interval_hours=0 short-circuits before any D1 read");
  }

  console.log("\nmaybeRunLrcBackfill — cadence throttle blocks a re-run inside the window:");
  {
    const sqlite = buildDb();
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('lrc_backfill_interval_hours', '24')");
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`INSERT INTO kv_store (key, value, updated_at) VALUES ('cron:last_lrc_backfill_ts', '${now}', ${now})`);
    const env = makeEnv(sqlite, { "music/Artist/Album/01 Has Sidecar.lrc": "[00:00.00]la la la" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeRunLrcBackfill(env as any, { waitUntil: () => {} } as any);
    const sm1 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-1'").get() as { lyrics: string | null };
    assert(sm1.lyrics === null, "sm-1 untouched — last run was just now, inside the 24h window");
  }

  console.log("\nmaybeRunLrcBackfill — runs when the window has elapsed:");
  {
    const sqlite = buildDb();
    sqlite.exec("INSERT INTO feature_strings (key, value) VALUES ('lrc_backfill_interval_hours', '24')");
    const stale = Math.floor(Date.now() / 1000) - 25 * 3600;
    sqlite.exec(`INSERT INTO kv_store (key, value, updated_at) VALUES ('cron:last_lrc_backfill_ts', '${stale}', ${stale})`);
    const env = makeEnv(sqlite, { "music/Artist/Album/01 Has Sidecar.lrc": "[00:00.00]la la la" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeRunLrcBackfill(env as any, { waitUntil: () => {} } as any);
    const sm1 = sqlite.prepare("SELECT lyrics FROM song_masters WHERE id = 'sm-1'").get() as { lyrics: string | null };
    assert(sm1.lyrics === "[00:00.00]la la la", "sm-1 filled — 25h-old last run is outside the 24h window");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed.");
}

main();
