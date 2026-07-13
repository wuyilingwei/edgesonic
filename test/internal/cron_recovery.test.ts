// Post-deploy cron auto-recovery (utils/cronRecovery.ts).
//
// Coverage:
//  1. No CF env → skipped-no-cf, zero fetches (never touches the CF API).
//  2. Recorded build === WORKER_VERSION → up-to-date, zero fetches (the cheap
//     common path: a pure env read, no CF/D1 writes).
//  3. Recorded build !== WORKER_VERSION → recovered: re-PUTs the recorded
//     schedule and re-stamps the build into both the Secret and D1.
//  4. No record + live schedules present → bootstrapped from live (no PUT).
//  5. No record + no live schedules → bootstrapped by applying the default.
//  6. Secret mirror write failing does NOT fail recovery — D1 still updated.
//  7. readCronState falls back to the D1 backup when the env Secret is absent.
//
// Mirrors test/internal/cf_ensure_default_cron.test.ts (fetch mock) and
// permissions_save.test.ts (node:sqlite D1 shim).
//
// Run: npx tsx test/internal/cron_recovery.test.ts

import { DatabaseSync } from "node:sqlite";
import { recoverCronIfStale, persistCronState, readCronState } from "../../worker/src/utils/cronRecovery";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim over node:sqlite
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bound: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { bound = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> { return (stmt.get(...bound) ?? null) as T | null; },
      async run() {
        const r = stmt.run(...bound);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>() { return { results: stmt.all(...bound) as T[], success: true, meta: {} }; },
    };
  }
  return { prepare };
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);`);
  return db;
}

function kvRow(sqlite: DatabaseSync, key: string): { value: string } | null {
  return (sqlite.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) ?? null) as { value: string } | null;
}

// ---------------------------------------------------------------------------
// Fetch mock (same harness shape as cf_ensure_default_cron.test.ts)
// ---------------------------------------------------------------------------
interface FetchExpectation {
  match: (req: Request, url: string) => boolean;
  reply: (req: Request) => Response | Promise<Response>;
  capture?: { req?: Request; body?: unknown };
}
let expectations: FetchExpectation[] = [];
let unexpectedCount = 0;
const realFetch = global.fetch;

function installMock() {
  expectations = [];
  unexpectedCount = 0;
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    for (let i = 0; i < expectations.length; i++) {
      const e = expectations[i];
      if (e.match(req, req.url)) {
        if (e.capture) {
          e.capture.req = req.clone();
          try { e.capture.body = await req.clone().json(); } catch { e.capture.body = undefined; }
        }
        expectations.splice(i, 1);
        return e.reply(req);
      }
    }
    unexpectedCount++;
    throw new Error(`Unexpected fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}
function uninstallMock() { global.fetch = realFetch; }
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SCHEDULES = "/workers/scripts/edgesonic/schedules";
const SECRETS = "/workers/scripts/edgesonic/secrets";

function expectSecretPut(capture?: { body?: unknown }, ok = true) {
  expectations.push({
    match: (r, url) => r.method === "PUT" && url.endsWith(SECRETS),
    reply: () => ok
      ? jsonResp({ success: true, result: { name: "CRON_STATE" } })
      : jsonResp({ success: false, errors: [{ message: "Workers Scripts:Edit required" }] }),
    capture: capture ? capture as FetchExpectation["capture"] : undefined,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function env(over: Record<string, unknown>): any {
  return { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc", WORKER_VERSION: "1", ...over };
}

async function run() {
  console.log("recoverCronIfStale — no CF env → skip, no fetch:");
  {
    installMock();
    const db = freshDb();
    const r = await recoverCronIfStale(env({ CF_API_TOKEN: undefined, DB: makeD1(db) }));
    assert(r.status === "skipped-no-cf", "status skipped-no-cf");
    assert(unexpectedCount === 0 && expectations.length === 0, "no CF fetch attempted");
    uninstallMock();
  }

  console.log("\nrecoverCronIfStale — build matches (env Secret) → up-to-date, no fetch:");
  {
    installMock();
    const db = freshDb();
    const e = env({
      WORKER_VERSION: "5",
      CRON_STATE: JSON.stringify({ crons: ["0 */1 * * *"], build: "5" }),
      DB: makeD1(db),
    });
    const r = await recoverCronIfStale(e);
    assert(r.status === "up-to-date", "status up-to-date");
    assert(unexpectedCount === 0 && expectations.length === 0, "zero fetches on the common path");
    uninstallMock();
  }

  console.log("\nrecoverCronIfStale — build changed → recovered (re-apply + re-stamp):");
  {
    installMock();
    const db = freshDb();
    const putSched: { body?: unknown } = {};
    const putSecret: { body?: unknown } = {};
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: [{ cron: "*/15 * * * *" }] }),
      capture: putSched,
    });
    expectSecretPut(putSecret, true);

    const e = env({
      WORKER_VERSION: "9",
      CRON_STATE: JSON.stringify({ crons: ["*/15 * * * *"], build: "4" }),
      DB: makeD1(db),
    });
    const r = await recoverCronIfStale(e) as { status: string; crons?: string[]; previousBuild?: string; build?: string };
    assert(r.status === "recovered", "status recovered");
    assert(r.previousBuild === "4" && r.build === "9", "previousBuild=4, build=9");
    const sched = putSched.body as Array<{ cron: string }>;
    assert(Array.isArray(sched) && sched.length === 1 && sched[0].cron === "*/15 * * * *",
      "PUT schedules re-applies the recorded cron verbatim");
    const secret = putSecret.body as { name?: string; text?: string; type?: string };
    assert(secret.name === "CRON_STATE" && secret.type === "secret_text", "Secret write is CRON_STATE/secret_text");
    assert(JSON.parse(secret.text || "{}").build === "9", "Secret text carries the new build 9");
    const row = kvRow(db, "cron_recovery_state");
    assert(!!row && JSON.parse(row.value).build === "9", "D1 backup re-stamped to build 9");
    assert(JSON.parse(row!.value).crons[0] === "*/15 * * * *", "D1 backup keeps the recorded cron");
    assert(expectations.length === 0 && unexpectedCount === 0, "exactly the schedules PUT + secret PUT happened");
    uninstallMock();
  }

  console.log("\nrecoverCronIfStale — no record, live schedules present → bootstrapped from live (no PUT):");
  {
    installMock();
    const db = freshDb();
    expectations.push({
      match: (r, url) => r.method === "GET" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: { schedules: [{ cron: "0 */2 * * *" }] } }),
    });
    expectSecretPut(undefined, true);
    // Tripwire: a PUT to schedules must NOT happen when live is adopted as baseline.
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: [] }),
      capture: { body: undefined },
    });

    const e = env({ WORKER_VERSION: "3", DB: makeD1(db) });
    const r = await recoverCronIfStale(e) as { status: string; crons?: string[] };
    assert(r.status === "bootstrapped", "status bootstrapped");
    assert((r.crons || [])[0] === "0 */2 * * *", "baseline adopts the live cadence");
    const row = kvRow(db, "cron_recovery_state");
    assert(!!row && JSON.parse(row.value).build === "3", "D1 baseline recorded at current build");
    assert(expectations.length === 1, "schedules PUT tripwire never fired (only GET + secret consumed)");
    uninstallMock();
  }

  console.log("\nrecoverCronIfStale — no record, no live schedules → bootstrapped by applying default:");
  {
    installMock();
    const db = freshDb();
    const putSched: { body?: unknown } = {};
    expectations.push({
      match: (r, url) => r.method === "GET" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: { schedules: [] } }),
    });
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: [{ cron: "0 */1 * * *" }] }),
      capture: putSched,
    });
    expectSecretPut(undefined, true);

    const e = env({ WORKER_VERSION: "7", DB: makeD1(db) });
    const r = await recoverCronIfStale(e) as { status: string; crons?: string[] };
    assert(r.status === "bootstrapped", "status bootstrapped");
    const sched = putSched.body as Array<{ cron: string }>;
    assert(Array.isArray(sched) && sched[0].cron === "0 */1 * * *", "applies the hourly default when nothing is live");
    assert(expectations.length === 0, "GET + PUT schedules + secret PUT all consumed");
    uninstallMock();
  }

  console.log("\nrecoverCronIfStale — Secret mirror write fails → still recovered, D1 updated:");
  {
    installMock();
    const db = freshDb();
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES),
      reply: () => jsonResp({ success: true, result: [{ cron: "0 */1 * * *" }] }),
    });
    expectSecretPut(undefined, false); // secret write rejected

    const e = env({
      WORKER_VERSION: "12",
      CRON_STATE: JSON.stringify({ crons: ["0 */1 * * *"], build: "11" }),
      DB: makeD1(db),
    });
    const r = await recoverCronIfStale(e) as { status: string };
    assert(r.status === "recovered", "recovery succeeds despite the Secret write failing");
    const row = kvRow(db, "cron_recovery_state");
    assert(!!row && JSON.parse(row.value).build === "12", "D1 backup still re-stamped to build 12");
    uninstallMock();
  }

  console.log("\nreadCronState — falls back to the D1 backup when the Secret is absent:");
  {
    const db = freshDb();
    await persistCronStateNoCf(db, { crons: ["*/30 * * * *"], build: "2" });
    const state = await readCronState(env({ CRON_STATE: undefined, DB: makeD1(db) }));
    assert(!!state && state.build === "2" && state.crons[0] === "*/30 * * * *",
      "state read back from D1 when env.CRON_STATE is unset");
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

// persistCronState with no CF env → D1-only write (no fetch needed).
async function persistCronStateNoCf(db: DatabaseSync, state: { crons: string[]; build: string }) {
  await persistCronState(env({ CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined, DB: makeD1(db) }), state);
}

run().catch((e) => { console.error(e); process.exit(1); });
