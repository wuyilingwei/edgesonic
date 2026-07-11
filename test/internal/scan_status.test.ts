// Run: npx tsx test/internal/scan_status.test.ts

import { createQueries } from "../../worker/src/db/queries";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ${"✓"} ${msg}`);
  else { failures++; console.error(`  ${"✗"} ${msg}`); }
}

// --- Minimal D1 mock (just enough to back scan_jobs) ---------------------------
// We model scan_jobs as an in-memory array and dispatch on the SQL string. This
// keeps the test zero-dep while still exercising the production query path.
interface JobRow {
  id: string;
  source_id: string;
  status: string;
  total_items: number;
  scanned_items: number;
  error_message: string | null;
  started_at: number;
  ended_at: number | null;
}

function makeDb() {
  const jobs: JobRow[] = [];

  function makeStmt(sql: string, binds: unknown[] = []): unknown {
    const trimmed = sql.trim().replace(/\s+/g, " ");
    return {
      bind(...args: unknown[]) {
        return makeStmt(sql, args);
      },
      async run() {
        if (trimmed.startsWith("INSERT INTO scan_jobs")) {
          // Synthetic monotonic start_at so the latest-per-source picker can
          // distinguish two jobs created in the same millisecond.
          const startedAt = (binds[2] as number) + jobs.length;
          jobs.push({
            id: binds[0] as string,
            source_id: binds[1] as string,
            status: "running",
            total_items: 0,
            scanned_items: 0,
            error_message: null,
            started_at: startedAt,
            ended_at: null,
          });
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE scan_jobs SET")) {
          // Parse "UPDATE scan_jobs SET col = ?, ... WHERE id = ?"
          const setPart = trimmed.slice("UPDATE scan_jobs SET ".length, trimmed.indexOf(" WHERE "));
          const cols = setPart.split(",").map((s) => s.trim().split(" ")[0]);
          const id = binds[binds.length - 1] as string;
          const row = jobs.find((j) => j.id === id);
          if (!row) return { success: true };
          for (let i = 0; i < cols.length; i++) {
            const v = binds[i];
            switch (cols[i]) {
              case "status": row.status = v as string; break;
              case "total_items": row.total_items = v as number; break;
              case "scanned_items": row.scanned_items = v as number; break;
              case "error_message": row.error_message = (v as string | null); break;
              case "ended_at": row.ended_at = (v as number | null); break;
            }
          }
          return { success: true };
        }
        throw new Error(`unmocked run sql: ${trimmed}`);
      },
      async all<T = unknown>() {
        if (trimmed.startsWith("SELECT sj.* FROM scan_jobs sj")) {
          // Latest per source by started_at DESC.
          const latestByGroup = new Map<string, JobRow>();
          for (const j of jobs) {
            const cur = latestByGroup.get(j.source_id);
            if (!cur || j.started_at > cur.started_at) latestByGroup.set(j.source_id, j);
          }
          const list = [...latestByGroup.values()].sort((a, b) => b.started_at - a.started_at);
          return { results: list as unknown as T[] };
        }
        throw new Error(`unmocked all sql: ${trimmed}`);
      },
      async first<T = unknown>() {
        return null as unknown as T;
      },
    };
  }

  return {
    prepare(sql: string) { return makeStmt(sql); },
    // expose internal store for assertions
    _jobs: jobs,
  } as unknown as D1Database & { _jobs: JobRow[] };
}

// Stub the global types we don't actually use in this test.
declare global {
  type D1Database = unknown;
}

console.log("scan_jobs lifecycle:");
(async () => {
  const db = makeDb() as ReturnType<typeof makeDb>;
  const q = createQueries(db as unknown as D1Database);

  await q.insertScanJob({ id: "job-1", sourceId: "src-a" });
  await q.insertScanJob({ id: "job-2", sourceId: "src-b" });

  let latest = await q.getLatestScanJobs();
  assert(latest.length === 2, "two jobs visible");
  assert(latest.every((j) => j.status === "running"), "both running on insert");
  // Aggregation reproduced inline (mirrors getScanStatus handler logic).
  const scanning1 = latest.some((j) => j.status === "running");
  const count1 = latest.reduce((acc, j) => acc + j.scanned_items, 0);
  assert(scanning1 === true, "scanning=true while any job is running");
  assert(count1 === 0, "count starts at 0");

  await q.updateScanJob("job-1", { scannedItems: 42, totalItems: 100 });
  latest = await q.getLatestScanJobs();
  const j1 = latest.find((j) => j.id === "job-1")!;
  assert(j1.scanned_items === 42 && j1.total_items === 100, "progress update lands");
  const count2 = latest.reduce((acc, j) => acc + j.scanned_items, 0);
  assert(count2 === 42, "aggregate count sums scanned_items");

  await q.updateScanJob("job-1", { status: "completed", endedAt: 999 });
  await q.updateScanJob("job-2", { status: "completed", endedAt: 999 });
  latest = await q.getLatestScanJobs();
  const scanning2 = latest.some((j) => j.status === "running");
  assert(scanning2 === false, "scanning=false once all jobs completed");

  // Failed-path test: a new running job + one already completed.
  await q.insertScanJob({ id: "job-3", sourceId: "src-a" });
  latest = await q.getLatestScanJobs();
  const j3 = latest.find((j) => j.id === "job-3");
  assert(!!j3 && j3.status === "running", "newest job per source supersedes older one");
  assert(latest.length === 2, "still only one row per source");

  await q.updateScanJob("job-3", { status: "failed", errorMessage: "boom", endedAt: 1000 });
  latest = await q.getLatestScanJobs();
  const j3f = latest.find((j) => j.id === "job-3")!;
  assert(j3f.status === "failed" && j3f.error_message === "boom", "failed status + error captured");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
