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
// accordingly: makeDb now handles kv_store queries and exposes a kvStore Map.
//
// Asserts maybeRunScheduledScan honours scan_interval_hours:
//   0   → returns without touching kv_store or scan_jobs
//   1   → runs every tick, dispatches one job per enabled WebDAV source
//  N > 1 → skipped when (now - last_scan_ts) < N*3600; ran otherwise
//
// Run: npx tsx test/internal/scheduled_scan.test.ts

import { maybeRunScheduledScan } from "../../worker/src/utils/scheduledScan";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type Env = unknown; }

interface SourceRow {
  id: string; base_url: string; username: string | null;
  password: string | null; root_path: string | null;
  // 089 S2 — scan mode column; optional in fixtures (defaults to library).
  mode?: string | null;
}

// ---------------------------------------------------------------------------
// D1 mock — now also handles kv_store queries (cron:last_scan_ts)
// ---------------------------------------------------------------------------
function makeDb(
  featureStrings: Record<string, string>,
  sources: SourceRow[],
  // Pre-seed kv_store (e.g. { "cron:last_scan_ts": "1234567890" })
  kvStoreInit: Record<string, string> = {},
) {
  const jobs: Array<{ id: string; source_id: string; started_at: number }> = [];
  const kvStore = new Map<string, string>(Object.entries(kvStoreInit));

  function makeStmt(sql: string, binds: unknown[] = []): unknown {
    const trimmed = sql.trim().replace(/\s+/g, " ");
    return {
      bind(...args: unknown[]) { return makeStmt(sql, args); },
      async run() {
        if (trimmed.startsWith("INSERT INTO scan_jobs")) {
          jobs.push({
            id: binds[0] as string,
            source_id: binds[1] as string,
            started_at: binds[2] as number,
          });
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE scan_jobs SET")) {
          return { success: true };
        }
        // kv_store UPSERT (from scheduledScan.ts)
        if (trimmed.startsWith("INSERT INTO kv_store")) {
          kvStore.set(binds[0] as string, binds[1] as string);
          return { success: true };
        }
        return { success: true };
      },
      async first<T = unknown>() {
        if (trimmed.startsWith("SELECT value FROM feature_strings")) {
          const key = binds[0] as string;
          const v = featureStrings[key];
          return (v !== undefined ? { value: v } : null) as unknown as T;
        }
        // kv_store GET
        if (trimmed.startsWith("SELECT value FROM kv_store WHERE key")) {
          const key = binds[0] as string;
          const v = kvStore.get(key);
          return (v !== undefined ? { value: v } : null) as unknown as T;
        }
        return null as unknown as T;
      },
      async all<T = unknown>() {
        if (trimmed.startsWith("SELECT key, value FROM feature_strings")) {
          return {
            results: Object.entries(featureStrings).map(
              ([key, value]) => ({ key, value }),
            ) as unknown as T[],
          };
        }
        // storage_sources query
        if (trimmed.startsWith("SELECT id, base_url, username, password") && trimmed.includes("FROM storage_sources")) {
          return { results: sources as unknown as T[] };
        }
        // existing-instance query inside asyncScanSource
        if (trimmed.startsWith("SELECT id, storage_uri, source_etag")) {
          return { results: [] as unknown as T[] };
        }
        return { results: [] as unknown as T[] };
      },
    };
  }
  return {
    db: { prepare(sql: string) { return makeStmt(sql); }, async batch() { return []; } },
    jobs,
    kvStore,
  };
}

// Stub fetch — every PROPFIND returns an empty multistatus so asyncScanSource
// finishes without doing storage I/O.
function installEmptyFetchMock() {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
  const stub = async () =>
    new Response(xml, { status: 207, headers: { "Content-Type": "application/xml" } });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
}

// ExecutionContext stub. Critically, waitUntil must await its promise so the
// helper's async work completes before our assertions read state.
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) { pending.push(p); },
      passThroughOnException() { /* noop */ },
    } as unknown as ExecutionContext,
    async settle() { await Promise.all(pending); },
  };
}

(async () => {
  installEmptyFetchMock();

  console.log("\nscan_interval_hours=0 → noop:");
  {
    const { db, jobs, kvStore } = makeDb({ scan_interval_hours: "0" }, [
      { id: "src-1", base_url: "http://dav.example.com", username: "u", password: "p", root_path: null },
    ]);
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 0, "no scan_jobs created");
    assert(!kvStore.has("cron:last_scan_ts"), "last_scan_ts not written");
  }

  console.log("\nscan_interval_hours=1 → run every tick:");
  {
    const { db, jobs, kvStore } = makeDb({ scan_interval_hours: "1", scan_etag_check: "1" }, [
      { id: "src-1", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      { id: "src-2", base_url: "http://dav2.example.com/dav", username: "u2", password: "p2", root_path: null },
    ]);
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 2, "one scan_jobs row per enabled WebDAV source");
    assert(kvStore.has("cron:last_scan_ts"), "last_scan_ts stamped");
  }

  console.log("\nscan_interval_hours=2 with no last_ts → run + stamp:");
  {
    const { db, jobs, kvStore } = makeDb({ scan_interval_hours: "2", scan_etag_check: "1" }, [
      { id: "src-1", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
    ]);
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 1, "ran because last_ts unset");
    assert(kvStore.has("cron:last_scan_ts"), "stamped last_scan_ts");
  }

  console.log("\nscan_interval_hours=2 with recent last_ts → skipped:");
  {
    // last_ts = now - 1h, threshold = 2h → still under, must skip
    const recent = Math.floor(Date.now() / 1000) - 3600;
    const { db, jobs, kvStore } = makeDb(
      { scan_interval_hours: "2", scan_etag_check: "1" },
      [{ id: "src-1", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null }],
      { "cron:last_scan_ts": String(recent) },
    );
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 0, "no jobs created because cadence not reached");
    // last_ts should remain unchanged
    assert(kvStore.get("cron:last_scan_ts") === String(recent), "last_ts unchanged on skip");
  }

  console.log("\nscan_interval_hours=2 with stale last_ts → run again:");
  {
    // last_ts = now - 3h, threshold = 2h → expired, must run
    const stale = Math.floor(Date.now() / 1000) - 3 * 3600;
    const { db, jobs, kvStore } = makeDb(
      { scan_interval_hours: "2", scan_etag_check: "1" },
      [{ id: "src-1", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null }],
      { "cron:last_scan_ts": String(stale) },
    );
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 1, "ran because last_ts older than threshold");
    assert(Number(kvStore.get("cron:last_scan_ts")) > stale, "last_ts refreshed");
  }

  console.log("\nno enabled sources → no jobs even at interval=1:");
  {
    const { db, jobs, kvStore } = makeDb({ scan_interval_hours: "1", scan_etag_check: "1" }, []);
    const { ctx, settle } = makeCtx();
    await maybeRunScheduledScan({ DB: db } as unknown as Env, ctx);
    await settle();
    assert(jobs.length === 0, "empty source list → empty jobs");
    // last_ts still stamped (we don't want to retry every tick when 0 sources)
    assert(kvStore.has("cron:last_scan_ts"), "stamp even with 0 sources");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
