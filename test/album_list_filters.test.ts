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

// musicFolderId influence the prepared SQL/binds as expected without hitting D1.
// Run: npx tsx test/album_list_filters.test.ts

import { createQueries } from "../worker/src/db/queries";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ${"✓"} ${msg}`);
  else { failures++; console.error(`  ${"✗"} ${msg}`); }
}

interface CapturedCall {
  sql: string;
  binds: unknown[];
}

function makeRecordingDb(rows: Array<Record<string, unknown>>) {
  const calls: CapturedCall[] = [];

  function makeStmt(sql: string, binds: unknown[] = []): unknown {
    return {
      bind(...args: unknown[]) {
        return makeStmt(sql, args);
      },
      async all<T = unknown>() {
        calls.push({ sql, binds });
        return { results: rows as unknown as T[] };
      },
      async run() { calls.push({ sql, binds }); return { success: true }; },
      async first<T = unknown>() { calls.push({ sql, binds }); return (rows[0] as unknown as T) ?? null; },
    };
  }

  return {
    prepare(sql: string) { return makeStmt(sql); },
    _calls: calls,
  } as unknown as D1Database & { _calls: CapturedCall[] };
}

declare global {
  type D1Database = unknown;
}

const sample = [
  { id: "al-1", name: "First", year: 2020, artist_name: "X", artist_id: "ar-1" },
  { id: "al-2", name: "Second", year: 2022, artist_name: "Y", artist_id: "ar-2" },
];

console.log("listAlbums byYear:");
(async () => {
  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    const out = await q.listAlbums("byYear", 50, 0, { fromYear: 2000, toYear: 2025 });
    const last = db._calls[db._calls.length - 1];
    assert(out.length === 2, "rows returned");
    assert(/a\.year BETWEEN \? AND \?/.test(last.sql), "BETWEEN clause emitted");
    assert(last.binds.slice(0, 2).join(",") === "2000,2025", "year range binds [from,to] ordered low,high");
    assert(/ORDER BY a\.year ASC/.test(last.sql), "ascending order when fromYear <= toYear");
  }

  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("byYear", 50, 0, { fromYear: 2025, toYear: 2000 });
    const last = db._calls[db._calls.length - 1];
    assert(last.binds.slice(0, 2).join(",") === "2000,2025", "binds normalised even when fromYear > toYear");
    assert(/ORDER BY a\.year DESC/.test(last.sql), "descending order when fromYear > toYear");
  }

  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("byYear", 50, 0, { fromYear: 2010 });
    const last = db._calls[db._calls.length - 1];
    assert(/a\.year >= \?/.test(last.sql), "open-ended fromYear only");
    assert(last.binds[0] === 2010, "bind=2010");
  }

  console.log("listAlbums byGenre:");
  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("byGenre", 10, 0, { genre: "Rock" });
    const last = db._calls[db._calls.length - 1];
    assert(/a\.genre = \?/.test(last.sql), "genre WHERE composed");
    assert(last.binds.includes("Rock"), "genre bind present");
  }

  {
    const db = makeRecordingDb([]) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    const out = await q.listAlbums("byGenre", 10, 0, {});
    assert(out.length === 0, "byGenre with no genre returns empty without hitting db");
    assert(db._calls.length === 0, "no SQL emitted on empty byGenre");
  }

  console.log("listAlbums musicFolderId:");
  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("newest", 10, 0, { musicFolderId: "src-42" });
    const last = db._calls[db._calls.length - 1];
    assert(/si3\.source_id = \?/.test(last.sql), "EXISTS subquery on song_instances.source_id");
    assert(last.binds.includes("src-42"), "musicFolderId bound");
  }

  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("newest", 10, 0, { musicFolderId: "default" });
    const last = db._calls[db._calls.length - 1];
    assert(!/si3\.source_id/.test(last.sql), `"default" folder skips source filter`);
  }

  console.log("listAlbums ORDER BY mapping:");
  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("alphabeticalByArtist", 10, 0);
    const last = db._calls[db._calls.length - 1];
    assert(/ORDER BY artist_sort ASC/.test(last.sql), "alphabeticalByArtist uses artist_sort");
  }

  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("highest", 10, 0);
    const last = db._calls[db._calls.length - 1];
    assert(/ORDER BY avg_rating DESC/.test(last.sql), "highest uses avg_rating");
  }

  {
    const db = makeRecordingDb(sample) as ReturnType<typeof makeRecordingDb>;
    const q = createQueries(db as unknown as D1Database);
    await q.listAlbums("random", 10, 0);
    const last = db._calls[db._calls.length - 1];
    assert(/ORDER BY RANDOM\(\)/.test(last.sql), "random uses RANDOM()");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
