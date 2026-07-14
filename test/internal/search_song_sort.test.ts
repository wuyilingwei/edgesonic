// Contract checks for the EdgeSonic-only search3 song sort extension.
// Run: npx tsx test/internal/search_song_sort.test.ts

import { createQueries } from "../../worker/src/db/queries";

declare global { type D1Database = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeDb() {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async all<T = unknown>() {
          calls.push(sql);
          return { results: [] as T[], success: true, meta: {} };
        },
      };
      return stmt;
    },
  };
  return { db, calls };
}

async function run() {
  for (const [sort, expected] of [
    [undefined, "ORDER BY sm.sort_title ASC"],
    ["title", "ORDER BY sm.sort_title ASC"],
    ["titleDesc", "ORDER BY sm.sort_title DESC"],
    ["newest", "ORDER BY sm.created_at DESC"],
  ] as const) {
    const { db, calls } = makeDb();
    const q = createQueries(db as D1Database);
    await q.search("", { artistCount: 0, albumCount: 0, songCount: 1, songSort: sort });
    const songSql = calls.find((sql) => sql.includes("FROM song_masters")) || "";
    assert(songSql.includes(expected), `song sort ${sort ?? "default"} uses ${expected}`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

void run();
