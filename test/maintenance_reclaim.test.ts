//
// The endpoint mirrors 052a's scheduled workReclaim sweep but is triggered by
// an admin. We exercise the same buckets workReclaim covers, plus the auth
// guard and the no-op shape:
//
// Coverage:
//   1. 3 claimed rows with heartbeat older than ttl and attempts<max → all
//      requeued, claimed_by/claimed_at/heartbeat_at cleared, attempts intact
//   2. 1 claimed row with attempts>=max → status=failed, error_message updated
//   3. Mixed batch — stale + fresh-claimed + queued; only stale ones touched
//   4. Non-admin (level=2) → 403, no rows mutated
//   5. No stale rows → ok:true, reclaimed=0, items=[]
//   6. Feature key worker_claim_ttl_seconds is honoured (default 60 used when
//      missing; 300 used when set)
//
// node:sqlite shim mirrors the cleanup_duplicate_covers.test.ts harness.
//
// Run: npx tsx test/maintenance_reclaim.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { maintenanceRoutes } from "../worker/src/endpoints/edgesonic/maintenance";

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

// Minimal schema: work_queue + a 1-row feature_strings so getFeatureString can
// resolve `worker_claim_ttl_seconds` (the endpoint reads it via the helper).
function buildDb(ttlValue?: string): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      payload TEXT,
      required_caps TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_by TEXT,
      claimed_at INTEGER,
      heartbeat_at INTEGER,
      result_json TEXT,
      error_message TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      created_at INTEGER DEFAULT 0,
      expires_at INTEGER
    );
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (3, 'maintenance_reclaim', 1, 0),
      (2, 'maintenance_reclaim', 0, 0),
      (1, 'maintenance_reclaim', 0, 0),
      (0, 'maintenance_reclaim', 0, 0);
  `);
  if (ttlValue !== undefined) {
    sqlite.prepare("INSERT INTO feature_strings (key, value) VALUES (?, ?)")
      .run("worker_claim_ttl_seconds", ttlValue);
  }
  return sqlite;
}

// Seed a claimed row. heartbeatAgo is how many seconds ago the heartbeat was;
// positive = older than now (stale candidate when > ttl).
interface SeedOpts {
  id: string;
  attempts?: number;
  maxAttempts?: number;
  heartbeatAgo?: number;       // seconds before now; 0 means "now"
  status?: string;             // default 'claimed'
  claimedBy?: string;
  errorMessage?: string | null;
}
function seedRow(sqlite: DatabaseSync, opts: SeedOpts) {
  const nowRow = sqlite.prepare("SELECT unixepoch() AS now").get() as { now: number };
  const heartbeatAt = (opts.status ?? "claimed") === "claimed"
    ? nowRow.now - (opts.heartbeatAgo ?? 0)
    : null;
  sqlite.prepare(`
    INSERT INTO work_queue
      (id, task_type, payload, status, claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, error_message, created_at)
    VALUES (?, 'metadata', '{}', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.status ?? "claimed",
    opts.status === "claimed" || opts.status === undefined ? (opts.claimedBy ?? "worker-a") : null,
    heartbeatAt,                       // claimed_at — coincides with heartbeat for the seed
    heartbeatAt,                       // heartbeat_at
    opts.attempts ?? 1,
    opts.maxAttempts ?? 3,
    opts.errorMessage ?? null,
    nowRow.now - 600,                  // created_at irrelevant
  );
}

function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", maintenanceRoutes);
  // KV stub — getFeatureString reads through KV before D1. Our mock is a plain
  // Map; we never need persistence across requests (each test rebuilds the env).
  const kvStore = new Map<string, string>();
  const kv = {
    async get(key: string) { return kvStore.has(key) ? kvStore.get(key)! : null; },
    async put(key: string, value: string) { kvStore.set(key, value); },
    async delete(key: string) { kvStore.delete(key); },
  };
  const env = { DB: makeD1(sqlite), KV: kv };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

interface ReclaimBody {
  ok: boolean;
  reclaimed?: number;
  requeued?: number;
  failed?: number;
  ttlSeconds?: number;
  items?: Array<{ id: string; status: string; attempts: number }>;
  error?: string;
}

async function main() {
  console.log("3 stale claimed rows (attempts<max) → all requeued, fields cleared:");
  {
    const sqlite = buildDb();    // default ttl = 60
    seedRow(sqlite, { id: "w-a", attempts: 1, heartbeatAgo: 120 });
    seedRow(sqlite, { id: "w-b", attempts: 2, heartbeatAgo: 90 });
    seedRow(sqlite, { id: "w-c", attempts: 0, heartbeatAgo: 75 });
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as ReclaimBody;
    assert(body.ok === true, "ok:true");
    assert(body.reclaimed === 3, `reclaimed=3 (got ${body.reclaimed})`);
    assert(body.requeued === 3, `requeued=3 (got ${body.requeued})`);
    assert(body.failed === 0, `failed=0 (got ${body.failed})`);
    assert(body.ttlSeconds === 60, `ttlSeconds=60 (got ${body.ttlSeconds})`);
    assert(Array.isArray(body.items) && body.items.length === 3,
      `items.length=3 (got ${body.items?.length})`);

    const rows = sqlite.prepare(
      "SELECT id, status, attempts, claimed_by, claimed_at, heartbeat_at FROM work_queue ORDER BY id",
    ).all() as Array<{ id: string; status: string; attempts: number; claimed_by: string | null; claimed_at: number | null; heartbeat_at: number | null }>;
    assert(rows.every((r) => r.status === "queued"), "all rows requeued");
    assert(rows.every((r) => r.claimed_by === null && r.claimed_at === null && r.heartbeat_at === null),
      "claimed_by/claimed_at/heartbeat_at all cleared");
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert(byId["w-a"].attempts === 1, `w-a attempts preserved (got ${byId["w-a"].attempts})`);
    assert(byId["w-b"].attempts === 2, `w-b attempts preserved (got ${byId["w-b"].attempts})`);
    assert(byId["w-c"].attempts === 0, `w-c attempts preserved (got ${byId["w-c"].attempts})`);
  }

  console.log("\nStale row with attempts>=max → failed terminal:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "w-dead", attempts: 3, maxAttempts: 3, heartbeatAgo: 200 });
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    const body = await r.json() as ReclaimBody;
    assert(body.reclaimed === 1, `reclaimed=1 (got ${body.reclaimed})`);
    assert(body.requeued === 0, `requeued=0 (got ${body.requeued})`);
    assert(body.failed === 1, `failed=1 (got ${body.failed})`);

    const row = sqlite.prepare("SELECT status, error_message, attempts FROM work_queue WHERE id='w-dead'").get() as { status: string; error_message: string | null; attempts: number };
    assert(row.status === "failed", `status='failed' (got ${row.status})`);
    assert(row.attempts === 3, `attempts preserved at 3 (got ${row.attempts})`);
    assert(typeof row.error_message === "string" && /max attempts|stale/i.test(row.error_message),
      `error_message hints at the reason (got "${row.error_message}")`);
  }

  console.log("\nMixed batch — stale + fresh-claimed + queued; only stale ones touched:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "w-stale1", attempts: 1, heartbeatAgo: 120 });
    seedRow(sqlite, { id: "w-stale2", attempts: 4, maxAttempts: 3, heartbeatAgo: 90 });
    // Fresh claim — heartbeat 10s ago (under default 60 ttl).
    seedRow(sqlite, { id: "w-fresh", attempts: 1, heartbeatAgo: 10 });
    // Plain queued row — never had a claim.
    seedRow(sqlite, { id: "w-queued", attempts: 0, status: "queued" });

    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    const body = await r.json() as ReclaimBody;
    assert(body.reclaimed === 2, `reclaimed=2 (got ${body.reclaimed})`);
    assert(body.requeued === 1, `requeued=1 (got ${body.requeued})`);
    assert(body.failed === 1, `failed=1 (got ${body.failed})`);

    const byId = Object.fromEntries(
      (sqlite.prepare("SELECT id, status, claimed_by FROM work_queue ORDER BY id").all() as Array<{ id: string; status: string; claimed_by: string | null }>)
        .map((r) => [r.id, r]),
    );
    assert(byId["w-stale1"].status === "queued", "stale-with-budget → queued");
    assert(byId["w-stale2"].status === "failed", "stale-exhausted → failed");
    assert(byId["w-fresh"].status === "claimed", "fresh-claimed untouched");
    assert(byId["w-fresh"].claimed_by !== null, "fresh-claimed claimed_by preserved");
    assert(byId["w-queued"].status === "queued", "already-queued row untouched");
  }

  console.log("\nNon-admin (level=2) → 403, no mutation (087 — permissionMiddleware XML):");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "w-x", attempts: 1, heartbeatAgo: 200 });
    const { post } = makeApp(sqlite, { username: "user", level: 2 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    assert(r.status === 403, `403 (got ${r.status})`);
    const text = await r.text();
    assert(text.includes("Not authorized"),
      `body mentions Not authorized (got "${text.slice(0, 80)}")`);
    const row = sqlite.prepare("SELECT status FROM work_queue WHERE id='w-x'").get() as { status: string };
    assert(row.status === "claimed", "row not mutated on 403");
  }

  console.log("\nNo stale rows → ok with reclaimed=0:");
  {
    const sqlite = buildDb();
    seedRow(sqlite, { id: "w-fresh-a", attempts: 1, heartbeatAgo: 5 });
    seedRow(sqlite, { id: "w-fresh-b", attempts: 0, status: "queued" });
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as ReclaimBody;
    assert(body.ok === true && body.reclaimed === 0, `reclaimed=0 (got ${body.reclaimed})`);
    assert(Array.isArray(body.items) && body.items.length === 0, "items empty");
  }

  console.log("\nCustom ttl from feature_strings is honoured (300s):");
  {
    const sqlite = buildDb("300");
    // 120s old — would be stale under default 60, but fresh under 300.
    seedRow(sqlite, { id: "w-mid", attempts: 1, heartbeatAgo: 120 });
    seedRow(sqlite, { id: "w-old", attempts: 1, heartbeatAgo: 360 });

    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/reclaimStaleWork", {});
    const body = await r.json() as ReclaimBody;
    assert(body.ttlSeconds === 300, `ttlSeconds=300 (got ${body.ttlSeconds})`);
    assert(body.reclaimed === 1, `only the >300s row reclaimed (got ${body.reclaimed})`);
    const byId = Object.fromEntries(
      (sqlite.prepare("SELECT id, status FROM work_queue ORDER BY id").all() as Array<{ id: string; status: string }>)
        .map((r) => [r.id, r]),
    );
    assert(byId["w-mid"].status === "claimed", "mid-age row preserved under wider ttl");
    assert(byId["w-old"].status === "queued", "old row reclaimed");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
