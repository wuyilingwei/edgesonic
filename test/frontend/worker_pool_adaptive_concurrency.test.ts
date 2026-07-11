// 113 — workerPool.nextConcurrency: AIMD-style adaptive concurrency step.
// worker_max_concurrent used to be the concurrency pollAndDrain always used;
// it's now a ceiling, and nextConcurrency decides the real per-cycle value:
//   - empty batch (no tasks polled)      → unchanged
//   - any failure in the batch           → halve (min 1)
//   - all tasks in the batch succeeded   → +1, capped at the ceiling
//
// We re-implement the function here rather than importing workerPool.ts
// directly — that module transitively imports Pinia/vue/api.ts, which touches
// `localStorage` at module-load time and throws outside a browser/jsdom
// context (same reason task_executor_error_msg.test.ts re-implements
// formatTaskError instead of importing it). A source-drift guard at the
// bottom keeps this copy honest against the real file.
//
// Run: npx tsx test/frontend/worker_pool_adaptive_concurrency.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// Re-declare the function under test — kept byte-identical to the source.
function nextConcurrency(
  current: number,
  ceiling: number,
  batch: { total: number; failed: number },
): number {
  if (batch.total === 0) return current;
  if (batch.failed > 0) return Math.max(1, Math.floor(current / 2));
  return Math.min(ceiling, current + 1);
}

async function main() {
  console.log("empty batch — no signal, concurrency unchanged:");
  {
    assert(nextConcurrency(3, 8, { total: 0, failed: 0 }) === 3, "3 stays 3 (no tasks polled)");
    assert(nextConcurrency(1, 8, { total: 0, failed: 0 }) === 1, "1 stays 1 (no tasks polled)");
  }

  console.log("\nall succeeded — ramps up by 1, capped at ceiling:");
  {
    assert(nextConcurrency(1, 8, { total: 2, failed: 0 }) === 2, "1 → 2");
    assert(nextConcurrency(7, 8, { total: 1, failed: 0 }) === 8, "7 → 8 (approaching ceiling)");
    assert(nextConcurrency(8, 8, { total: 1, failed: 0 }) === 8, "8 stays 8 (already at ceiling)");
    assert(nextConcurrency(5, 3, { total: 1, failed: 0 }) === 3, "5 → 3 (ceiling was lowered underneath it)");
  }

  console.log("\nany failure — halves (min 1), regardless of how many succeeded alongside it:");
  {
    assert(nextConcurrency(8, 8, { total: 3, failed: 1 }) === 4, "8 → 4 (one failure among three)");
    assert(nextConcurrency(2, 8, { total: 2, failed: 2 }) === 1, "2 → 1 (floor(2/2)=1)");
    assert(nextConcurrency(1, 8, { total: 1, failed: 1 }) === 1, "1 stays 1 (floor(1/2)=0, clamped to 1)");
    assert(nextConcurrency(3, 8, { total: 4, failed: 4 }) === 1, "3 → 1 (floor(3/2)=1)");
  }

  console.log("\nfull ramp-then-backoff cycle (simulating repeated polls):");
  {
    let c = 1;
    // Three clean cycles: 1 → 2 → 3 → 4.
    c = nextConcurrency(c, 8, { total: 2, failed: 0 });
    c = nextConcurrency(c, 8, { total: 3, failed: 0 });
    c = nextConcurrency(c, 8, { total: 4, failed: 0 });
    assert(c === 4, `ramped to 4 after 3 clean cycles (got ${c})`);
    // One bad cycle halves it immediately.
    c = nextConcurrency(c, 8, { total: 4, failed: 1 });
    assert(c === 2, `halved to 2 after a failure (got ${c})`);
    // Recovers by ramping again.
    c = nextConcurrency(c, 8, { total: 2, failed: 0 });
    assert(c === 3, `resumes ramping to 3 after recovery (got ${c})`);
  }

  console.log("\nproduction source drift guard:");
  {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../web/src/stores/workerPool.ts"),
      "utf-8",
    );
    assert(src.includes("export function nextConcurrency"),
      "nextConcurrency still exported from workerPool.ts");
    assert(/if \(batch\.total === 0\) return current;/.test(src),
      "empty-batch short-circuit still present");
    assert(/if \(batch\.failed > 0\) return Math\.max\(1, Math\.floor\(current \/ 2\)\);/.test(src),
      "halve-on-failure branch still present");
    assert(/return Math\.min\(ceiling, current \+ 1\);/.test(src),
      "ramp-up-capped-at-ceiling branch still present");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed.");
}

main();
