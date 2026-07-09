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
//   * getAnnotationsMap chunks ≤ 80 ids per query, merges results into a Map.
//   * getAnnotationsMap(empty) short-circuits with zero prepare() calls.
//   * getSongMastersByIds chunks ≤ 80, concatenates rows, dedupes input.
//   * getSongMastersByIds(empty) short-circuits.
//   * getAlbumsByArtist chunks album_id list returned by the DISTINCT scan
//     and re-applies ORDER BY year DESC, sort_name ASC NULLS LAST in JS.
//   * computePlaylistTotals chunks song id list, sums COUNT(*) + duration.
//
// The mock D1 here is a spy that records every prepare() / bind() call so we
// can assert chunk counts deterministically without spinning up node:sqlite.
//
// Run: npx tsx test/d1_in_batch.test.ts

import { createQueries } from "../worker/src/db/queries";

declare global { type D1Database = unknown; }

// ----------------------------------------------------------------------------
// Tiny test harness
// ----------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// ----------------------------------------------------------------------------
// Spy-D1: each prepare() is recorded; bind() captures args; all()/first() return
// rows from per-call canned responses (mapped by SQL prefix). Pass a `respond`
// closure to supply rows based on the bound args of each call.
// ----------------------------------------------------------------------------
type CallRow = {
  sql: string;
  binds: unknown[];
  /** the actual ? count appearing in the IN(...) clause (best-effort) */
  inCount: number;
};

function inPlaceholderCount(sql: string): number {
  // Count ? inside the first `IN (…)` parens; defensive for nested SQL.
  const m = sql.match(/IN\s*\(([^)]*)\)/i);
  if (!m) return 0;
  return (m[1].match(/\?/g) ?? []).length;
}

function makeSpyDb(
  respond: (call: CallRow) => { results?: unknown[]; first?: unknown },
): { db: unknown; calls: CallRow[] } {
  const calls: CallRow[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<T = unknown>() {
          const call: CallRow = { sql, binds: bound, inCount: inPlaceholderCount(sql) };
          calls.push(call);
          const r = respond(call);
          return { results: (r.results ?? []) as T[], success: true, meta: {} };
        },
        async first<T = unknown>() {
          const call: CallRow = { sql, binds: bound, inCount: inPlaceholderCount(sql) };
          calls.push(call);
          const r = respond(call);
          return (r.first ?? null) as T | null;
        },
        async run() {
          calls.push({ sql, binds: bound, inCount: inPlaceholderCount(sql) });
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  return { db, calls };
}

async function run() {
  // ---------------------------------------------------------------------------
  // getAnnotationsMap — 200 ids → 3 batches (80 + 80 + 40)
  // ---------------------------------------------------------------------------
  console.log("getAnnotationsMap (200 ids → 3 batches):");
  {
    const ids = Array.from({ length: 200 }, (_, i) => `song-${i}`);
    const { db, calls } = makeSpyDb((call) => {
      // Return one annotation row per bound id (skip the first 2 fixed binds).
      const annIds = call.binds.slice(2) as string[];
      const results = annIds.map((id) => ({
        user_id: "alice",
        item_type: "song",
        item_id: id,
        starred: 0,
        starred_at: null,
        rating: null,
        play_count: 0,
        play_date: null,
      }));
      return { results };
    });
    const q = createQueries(db as D1Database);
    const map = await q.getAnnotationsMap("alice", "song", ids);

    assert(calls.length === 3, "exactly 3 prepare() calls for 200 ids");
    assert(calls[0].inCount === 80, "batch 1 has 80 ? placeholders");
    assert(calls[1].inCount === 80, "batch 2 has 80 ? placeholders");
    assert(calls[2].inCount === 40, "batch 3 has 40 ? placeholders");
    assert(map.size === 200, "merged Map has all 200 entries");
    assert(map.get("song:song-0") !== undefined, "first id present");
    assert(map.get("song:song-199") !== undefined, "last id present");
    assert(
      calls.every((c) => c.binds[0] === "alice" && c.binds[1] === "song"),
      "fixed params user_id + item_type forwarded each batch",
    );
    // No batch should exceed the D1 cap with headroom (80 + 2 = 82).
    assert(
      calls.every((c) => c.binds.length <= 82),
      "no batch crosses D1 ~100 bind cap (≤ 82 with fixed params)",
    );
  }

  // ---------------------------------------------------------------------------
  // getAnnotationsMap — 0 ids short-circuits, no prepare() call
  // ---------------------------------------------------------------------------
  console.log("\ngetAnnotationsMap (0 ids → short-circuit):");
  {
    const { db, calls } = makeSpyDb(() => ({ results: [] }));
    const q = createQueries(db as D1Database);
    const map = await q.getAnnotationsMap("alice", "song", []);
    assert(map.size === 0, "empty Map returned");
    assert(calls.length === 0, "no SQL issued for empty id list");
  }

  // ---------------------------------------------------------------------------
  // getAnnotationsMap — duplicate ids deduped before chunking
  // ---------------------------------------------------------------------------
  console.log("\ngetAnnotationsMap (dedup + small set → 1 batch):");
  {
    const ids = ["a", "b", "a", "c", "b"];
    const { db, calls } = makeSpyDb((call) => {
      const annIds = call.binds.slice(2) as string[];
      return {
        results: annIds.map((id) => ({
          user_id: "alice", item_type: "album", item_id: id,
          starred: 1, starred_at: 1, rating: null, play_count: 0, play_date: null,
        })),
      };
    });
    const q = createQueries(db as D1Database);
    const map = await q.getAnnotationsMap("alice", "album", ids);
    assert(calls.length === 1, "1 batch for ≤ 80 deduped ids");
    assert(calls[0].inCount === 3, "3 unique ids → 3 placeholders");
    assert(map.size === 3, "Map has 3 unique entries");
  }

  // ---------------------------------------------------------------------------
  // getSongMastersByIds — 200 ids → 3 batches, rows concatenated
  // ---------------------------------------------------------------------------
  console.log("\ngetSongMastersByIds (200 ids → 3 batches):");
  {
    const ids = Array.from({ length: 200 }, (_, i) => `s-${i}`);
    const { db, calls } = makeSpyDb((call) => {
      const songIds = call.binds as string[];
      return {
        results: songIds.map((id) => ({ id, title: `t-${id}`, artist_id: "ar", album_id: "al" })),
      };
    });
    const q = createQueries(db as D1Database);
    const rows = await q.getSongMastersByIds(ids);
    assert(calls.length === 3, "3 prepare() calls for 200 ids");
    assert(calls[0].inCount === 80, "batch 1 has 80 ? placeholders");
    assert(calls[1].inCount === 80, "batch 2 has 80 ? placeholders");
    assert(calls[2].inCount === 40, "batch 3 has 40 ? placeholders");
    assert(rows.length === 200, "all 200 song_masters concatenated");
    assert(rows[0].id === "s-0", "row order preserved across batches (head)");
    assert(rows[199].id === "s-199", "row order preserved across batches (tail)");
  }

  // ---------------------------------------------------------------------------
  // getSongMastersByIds — 0 ids short-circuits
  // ---------------------------------------------------------------------------
  console.log("\ngetSongMastersByIds (0 ids → short-circuit):");
  {
    const { db, calls } = makeSpyDb(() => ({ results: [] }));
    const q = createQueries(db as D1Database);
    const rows = await q.getSongMastersByIds([]);
    assert(rows.length === 0, "empty array returned");
    assert(calls.length === 0, "no SQL issued");
  }

  // ---------------------------------------------------------------------------
  // getSongMastersByIds — duplicates deduped
  // ---------------------------------------------------------------------------
  console.log("\ngetSongMastersByIds (dedup):");
  {
    const ids = ["a", "b", "a", "b", "c"];
    const { db, calls } = makeSpyDb((call) => {
      const songIds = call.binds as string[];
      return { results: songIds.map((id) => ({ id })) };
    });
    const q = createQueries(db as D1Database);
    const rows = await q.getSongMastersByIds(ids);
    assert(calls.length === 1, "1 batch (3 unique)");
    assert(calls[0].inCount === 3, "3 unique placeholders");
    assert(rows.length === 3, "3 deduped rows");
  }

  // ---------------------------------------------------------------------------
  // getAlbumsByArtist — DISTINCT scan returns 200 albums → 3 batches + JS sort
  // ---------------------------------------------------------------------------
  console.log("\ngetAlbumsByArtist (200 albums → 3 batches + ORDER BY in JS):");
  {
    const albumIds = Array.from({ length: 200 }, (_, i) => `al-${i}`);
    // Plan responses:
    //   1st prepare = DISTINCT song_masters scan → 200 rows
    //   subsequent prepares = 3 batched album fetches
    let stage = 0;
    const { db, calls } = makeSpyDb((call) => {
      if (call.sql.includes("SELECT DISTINCT album_id")) {
        stage++;
        return { results: albumIds.map((id) => ({ album_id: id })) };
      }
      const batchIds = call.binds as string[];
      // Give each album a year so we can verify ORDER BY year DESC. Use the
      // numeric suffix as a stable sort key.
      return {
        results: batchIds.map((id) => {
          const n = parseInt(id.slice(3), 10);
          return { id, name: `Album ${n}`, sort_name: `Album ${String(n).padStart(4, "0")}`, year: n };
        }),
      };
    });
    const q = createQueries(db as D1Database);
    const rows = await q.getAlbumsByArtist("ar-1");
    // 1 DISTINCT + 3 IN batches = 4 prepare calls
    assert(calls.length === 4, "4 prepare() calls (1 DISTINCT + 3 IN batches)");
    const inCalls = calls.filter((c) => c.sql.includes("WHERE id IN"));
    assert(inCalls.length === 3, "3 album-fetch batches");
    assert(inCalls[0].inCount === 80, "album batch 1: 80 placeholders");
    assert(inCalls[1].inCount === 80, "album batch 2: 80 placeholders");
    assert(inCalls[2].inCount === 40, "album batch 3: 40 placeholders");
    assert(rows.length === 200, "200 albums returned");
    // ORDER BY year DESC: al-199 should appear before al-0
    assert(rows[0].id === "al-199", "ORDER BY year DESC respected (al-199 first)");
    assert(rows[199].id === "al-0", "ORDER BY year DESC respected (al-0 last)");
    void stage;
  }

  // ---------------------------------------------------------------------------
  // getAlbumsByArtist — empty distinct → no IN batches
  // ---------------------------------------------------------------------------
  console.log("\ngetAlbumsByArtist (no albums → no IN batches):");
  {
    const { db, calls } = makeSpyDb(() => ({ results: [] }));
    const q = createQueries(db as D1Database);
    const rows = await q.getAlbumsByArtist("ar-empty");
    assert(rows.length === 0, "empty result");
    assert(calls.length === 1, "only the DISTINCT scan ran");
  }

  // ---------------------------------------------------------------------------
  // computePlaylistTotals — via createPlaylist (200 songs → 3 batches)
  // ---------------------------------------------------------------------------
  console.log("\ncomputePlaylistTotals (200 songs → 3 batches):");
  {
    const songIds = Array.from({ length: 200 }, (_, i) => `pl-${i}`);
    const { db, calls } = makeSpyDb((call) => {
      if (call.sql.includes("COUNT(*)") && call.sql.includes("WHERE id IN")) {
        const batchIds = call.binds as string[];
        return { first: { count: batchIds.length, duration: batchIds.length * 100 } };
      }
      return {};
    });
    const q = createQueries(db as D1Database);
    await q.createPlaylist({ id: "pl-x", name: "x", owner: "alice", songIds });
    // Drop the trailing INSERT statements — focus on the SELECT COUNT(*) chunks.
    const sumCalls = calls.filter((c) => c.sql.includes("COUNT(*)") && c.sql.includes("WHERE id IN"));
    assert(sumCalls.length === 3, "3 totals batches for 200 song ids");
    assert(sumCalls[0].inCount === 80, "totals batch 1: 80 placeholders");
    assert(sumCalls[1].inCount === 80, "totals batch 2: 80 placeholders");
    assert(sumCalls[2].inCount === 40, "totals batch 3: 40 placeholders");
  }

  // ---------------------------------------------------------------------------
  // computePlaylistTotals — 0 songs short-circuits
  // ---------------------------------------------------------------------------
  console.log("\ncomputePlaylistTotals (0 songs → short-circuit):");
  {
    const { db, calls } = makeSpyDb(() => ({}));
    const q = createQueries(db as D1Database);
    await q.createPlaylist({ id: "pl-empty", name: "empty", owner: "alice", songIds: [] });
    const sumCalls = calls.filter((c) => c.sql.includes("COUNT(*)") && c.sql.includes("WHERE id IN"));
    assert(sumCalls.length === 0, "no totals SQL issued for empty playlist");
  }

  // ---------------------------------------------------------------------------
  // Sanity: exactly-80 boundary issues exactly 1 batch (no off-by-one)
  // ---------------------------------------------------------------------------
  console.log("\nexact-boundary sanity (80 ids → 1 batch, 81 ids → 2 batches):");
  {
    const exact80 = Array.from({ length: 80 }, (_, i) => `e-${i}`);
    const exact81 = Array.from({ length: 81 }, (_, i) => `e-${i}`);
    {
      const { db, calls } = makeSpyDb((call) => ({
        results: (call.binds.slice(2) as string[]).map((id) => ({
          user_id: "u", item_type: "song", item_id: id,
          starred: 0, starred_at: null, rating: null, play_count: 0, play_date: null,
        })),
      }));
      const q = createQueries(db as D1Database);
      const m = await q.getAnnotationsMap("u", "song", exact80);
      assert(calls.length === 1, "exactly 80 ids = 1 batch");
      assert(calls[0].inCount === 80, "1st batch has 80 placeholders");
      assert(m.size === 80, "Map size 80");
    }
    {
      const { db, calls } = makeSpyDb((call) => ({
        results: (call.binds.slice(2) as string[]).map((id) => ({
          user_id: "u", item_type: "song", item_id: id,
          starred: 0, starred_at: null, rating: null, play_count: 0, play_date: null,
        })),
      }));
      const q = createQueries(db as D1Database);
      const m = await q.getAnnotationsMap("u", "song", exact81);
      assert(calls.length === 2, "81 ids = 2 batches");
      assert(calls[0].inCount === 80, "1st batch has 80 placeholders");
      assert(calls[1].inCount === 1, "2nd batch has 1 placeholder");
      assert(m.size === 81, "Map size 81");
    }
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
