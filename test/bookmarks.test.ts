// ============================================================================
// 037 — Bookmarks + PlayQueue queries round-trip
// Run: npx tsx test/bookmarks.test.ts
// ----------------------------------------------------------------------------
// Uses an in-memory D1 mock that recognises just the SQL statements created by
// the queries we ship in this task (bookmarks UPSERT/SELECT/DELETE,
// play_queues UPSERT/SELECT, song_masters lookup by id list). The mock keeps
// the tests independent from miniflare / wrangler and matches the existing
// `npx tsx` flow used by test/tagwrite.test.ts.
// ============================================================================

import { createQueries } from "../worker/src/db/queries";

// ---------------------------------------------------------------------------
// In-memory D1 mock
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface MockTables {
  bookmarks: Row[];
  play_queues: Row[];
  song_masters: Row[];
}

function makeDb(initial: { song_masters?: Row[] } = {}): {
  db: import("@cloudflare/workers-types").D1Database;
  tables: MockTables;
} {
  const tables: MockTables = {
    bookmarks: [],
    play_queues: [],
    song_masters: [...(initial.song_masters ?? [])],
  };

  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

  const prepare = (rawSql: string) => {
    const sql = norm(rawSql);
    let binds: unknown[] = [];

    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async all<T = Row>() {
        return { results: run<T>(sql, binds) };
      },
      async first<T = Row>() {
        const rows = run<T>(sql, binds);
        return rows.length > 0 ? rows[0] : null;
      },
      async run() {
        run(sql, binds);
        return { success: true } as const;
      },
    };
    return stmt;
  };

  function run<T>(sql: string, binds: unknown[]): T[] {
    // -------- bookmarks --------
    if (/^SELECT \* FROM bookmarks WHERE user_id = \? ORDER BY updated_at DESC$/i.test(sql)) {
      const [uid] = binds;
      return tables.bookmarks
        .filter((r) => r.user_id === uid)
        .sort((a, b) => Number(b.updated_at) - Number(a.updated_at)) as T[];
    }
    if (sql.startsWith("INSERT INTO bookmarks")) {
      const [uid, sid, pos, comment, created, updated] = binds;
      const existing = tables.bookmarks.find(
        (r) => r.user_id === uid && r.song_master_id === sid,
      );
      if (existing) {
        existing.position_ms = pos;
        existing.comment = comment;
        existing.updated_at = updated;
      } else {
        tables.bookmarks.push({
          user_id: uid, song_master_id: sid, position_ms: pos,
          comment: comment, created_at: created, updated_at: updated,
        });
      }
      return [];
    }
    if (sql.startsWith("DELETE FROM bookmarks WHERE user_id = ? AND song_master_id = ?")) {
      const [uid, sid] = binds;
      tables.bookmarks = tables.bookmarks.filter(
        (r) => !(r.user_id === uid && r.song_master_id === sid),
      );
      return [];
    }

    // -------- play_queues --------
    if (/^SELECT \* FROM play_queues WHERE user_id = \?$/i.test(sql)) {
      const [uid] = binds;
      return tables.play_queues.filter((r) => r.user_id === uid) as T[];
    }
    if (sql.startsWith("INSERT INTO play_queues")) {
      const [uid, songIdsJson, currentId, positionMs, changedBy, updated] = binds;
      const existing = tables.play_queues.find((r) => r.user_id === uid);
      if (existing) {
        existing.song_ids = songIdsJson;
        existing.current_id = currentId;
        existing.position_ms = positionMs;
        existing.changed_by = changedBy;
        existing.updated_at = updated;
      } else {
        tables.play_queues.push({
          user_id: uid, song_ids: songIdsJson, current_id: currentId,
          position_ms: positionMs, changed_by: changedBy, updated_at: updated,
        });
      }
      return [];
    }

    // -------- song_masters lookup by id list --------
    const songMastersIn = sql.match(/^SELECT \* FROM song_masters WHERE id IN \(([?,\s]+)\)$/i);
    if (songMastersIn) {
      const idSet = new Set(binds as string[]);
      return tables.song_masters.filter((r) => idSet.has(r.id as string)) as T[];
    }
    if (sql === "SELECT * FROM song_masters WHERE id = ?") {
      const [id] = binds;
      return tables.song_masters.filter((r) => r.id === id) as T[];
    }

    throw new Error(`MockD1 unrecognised SQL: ${sql}`);
  }

  // Minimal cast — only the methods exercised by createQueries are implemented.
  return {
    db: { prepare } as unknown as import("@cloudflare/workers-types").D1Database,
    tables,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function songRow(id: string, title: string, albumId = `al-${id}`): Row {
  return {
    id, album_id: albumId, artist_id: `ar-${id}`, album_artist_id: null,
    title, sort_title: title, track: 1, disc: 1, duration: 200, genre: "Test",
    compilation: 0, participants: null,
    created_at: 1_700_000_000, updated_at: 1_700_000_000,
  };
}

async function main() {
// ---------------------------------------------------------------------------
// Test 1 — bookmarks round-trip
// ---------------------------------------------------------------------------
console.log("Bookmarks:");
{
  const songMasters = [
    songRow("song-a", "Alpha"),
    songRow("song-b", "Bravo"),
    songRow("song-c", "Charlie"),
  ];
  const { db, tables } = makeDb({ song_masters: songMasters });
  const queries = createQueries(db);

  // empty initially
  let bms = await queries.getBookmarksByUser("rosmontis");
  assert(bms.length === 0, "fresh user has no bookmarks");

  // createBookmark → upsert (twice = last-write-wins)
  await queries.upsertBookmark({
    username: "rosmontis", songMasterId: "song-a",
    positionMs: 1234, comment: "first scrub",
  });
  await queries.upsertBookmark({
    username: "rosmontis", songMasterId: "song-a",
    positionMs: 5678, comment: "updated",
  });
  await queries.upsertBookmark({
    username: "rosmontis", songMasterId: "song-b",
    positionMs: 999, comment: null,
  });

  bms = await queries.getBookmarksByUser("rosmontis");
  assert(bms.length === 2, `getBookmarks returns both rows (got ${bms.length})`);

  const a = bms.find((b) => b.song_master_id === "song-a")!;
  assert(a.position_ms === 5678, `song-a position is the updated value (got ${a.position_ms})`);
  assert(a.comment === "updated", `song-a comment is the updated value (got ${a.comment})`);

  const b = bms.find((b) => b.song_master_id === "song-b")!;
  assert(b.comment === null, "song-b comment is null (no value provided)");

  // deleteBookmark
  await queries.deleteBookmark("rosmontis", "song-a");
  bms = await queries.getBookmarksByUser("rosmontis");
  assert(bms.length === 1 && bms[0].song_master_id === "song-b",
    "deleteBookmark drops only the targeted row");

  // another user is isolated
  await queries.upsertBookmark({
    username: "other", songMasterId: "song-c", positionMs: 42, comment: null,
  });
  const mine = await queries.getBookmarksByUser("rosmontis");
  const theirs = await queries.getBookmarksByUser("other");
  assert(mine.length === 1, "user isolation: rosmontis still has 1");
  assert(theirs.length === 1 && theirs[0].song_master_id === "song-c",
    "user isolation: other has their own bookmark");

  // sanity on the mock storage layout
  assert(tables.bookmarks.length === 2, "underlying table has 2 surviving rows");
}

// ---------------------------------------------------------------------------
// Test 2 — play queue round-trip with ordered entries
// ---------------------------------------------------------------------------
console.log("PlayQueue:");
{
  const songMasters = [
    songRow("song-a", "Alpha"),
    songRow("song-b", "Bravo"),
    songRow("song-c", "Charlie"),
  ];
  const { db } = makeDb({ song_masters: songMasters });
  const queries = createQueries(db);

  let q = await queries.getPlayQueue("rosmontis");
  assert(q === null, "no queue saved → returns null");

  await queries.savePlayQueue({
    username: "rosmontis",
    songIds: ["song-a", "song-b", "song-c"],
    currentId: "song-b",
    positionMs: 10000,
    changedBy: "EdgeSonic-Web/test",
  });

  q = await queries.getPlayQueue("rosmontis");
  assert(q !== null, "queue is persisted");
  assert(q!.current_id === "song-b", `current_id = song-b (got ${q!.current_id})`);
  assert(q!.position_ms === 10000, `position_ms = 10000 (got ${q!.position_ms})`);
  assert(q!.changed_by === "EdgeSonic-Web/test", "changed_by stored");

  // song_ids preserved as JSON in order
  const parsed = JSON.parse(q!.song_ids);
  assert(
    Array.isArray(parsed) && parsed.length === 3
      && parsed[0] === "song-a" && parsed[1] === "song-b" && parsed[2] === "song-c",
    "song_ids JSON preserves order",
  );

  // resolve metadata via getSongMastersByIds + manual reorder (matches endpoint)
  const fetched = await queries.getSongMastersByIds(parsed);
  const byId = new Map(fetched.map((s) => [s.id, s]));
  const ordered = parsed.map((id: string) => byId.get(id)!);
  assert(
    ordered.length === 3
      && ordered[0].title === "Alpha"
      && ordered[1].title === "Bravo"
      && ordered[2].title === "Charlie",
    "entries resolved in queue order",
  );

  // Last-write-wins: smaller queue, new current
  await queries.savePlayQueue({
    username: "rosmontis",
    songIds: ["song-c"],
    currentId: "song-c",
    positionMs: 0,
    changedBy: null,
  });
  q = await queries.getPlayQueue("rosmontis");
  const reparsed = JSON.parse(q!.song_ids);
  assert(reparsed.length === 1 && reparsed[0] === "song-c",
    "savePlayQueue overwrites previous queue (last-write-wins)");
  assert(q!.current_id === "song-c" && q!.position_ms === 0,
    "current/position overwritten");
  assert(q!.changed_by === null, "changed_by overwritten with null");
}

// ---------------------------------------------------------------------------
// Test 3 — empty / edge cases
// ---------------------------------------------------------------------------
console.log("Edge cases:");
{
  const { db } = makeDb({});
  const queries = createQueries(db);

  // delete on missing row is a no-op (no throw)
  await queries.deleteBookmark("ghost", "song-missing");
  assert(true, "deleteBookmark on missing row does not throw");

  // empty queue id list still saves
  await queries.savePlayQueue({
    username: "ghost", songIds: [], currentId: null, positionMs: 0, changedBy: null,
  });
  const q = await queries.getPlayQueue("ghost");
  assert(q !== null && q.song_ids === "[]", "empty queue saved as []");

  // getSongMastersByIds([]) short-circuits without hitting SQL
  const empty = await queries.getSongMastersByIds([]);
  assert(Array.isArray(empty) && empty.length === 0, "getSongMastersByIds([]) returns []");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
