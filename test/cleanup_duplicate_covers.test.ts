//
// Coverage:
//  1. 3 albums share same cover_r2_key → 1 keeps it (smallest id), 2 NULL'd
//  2. Multiple duplicate groups handled in one call
//  3. Non-admin (level<3) → 403
//  4. No duplicates in DB → ok:true with groups=0, cleared=0
//  5. NULL cover_r2_key rows are ignored (not "duplicates of NULL")
//  6. R2 objects are NOT touched (we only mutate the D1 row)
//
// Run: npx tsx test/cleanup_duplicate_covers.test.ts

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

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  // Mirror of the 018 albums schema fields the endpoint touches.
  sqlite.exec(`
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cover_r2_key TEXT,
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
      (3, 'maintenance_cleanup', 1, 0),
      (2, 'maintenance_cleanup', 0, 0),
      (1, 'maintenance_cleanup', 0, 0),
      (0, 'maintenance_cleanup', 0, 0);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness — pre-injects a user with arbitrary level. The maintenance
// route gates internally on user.level<3; no permissionMiddleware involved.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, user: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...user, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", maintenanceRoutes);
  const env = { DB: makeD1(sqlite) };
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

async function main() {

  console.log("3 albums sharing one cover_r2_key → keep smallest id, NULL the rest:");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO albums (id, name, cover_r2_key) VALUES
        ('al-aaa', 'Alpha',  'covers/shared-anime'),
        ('al-bbb', 'Bravo',  'covers/shared-anime'),
        ('al-ccc', 'Charlie','covers/shared-anime');
    `);
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { ok: boolean; groups: number; cleared: number };
    assert(body.ok === true, "ok:true");
    assert(body.groups === 1, `groups=1 (got ${body.groups})`);
    assert(body.cleared === 2, `cleared=2 (got ${body.cleared})`);

    const rows = sqlite.prepare("SELECT id, cover_r2_key FROM albums ORDER BY id").all() as Array<{ id: string; cover_r2_key: string | null }>;
    assert(rows[0].id === "al-aaa" && rows[0].cover_r2_key === "covers/shared-anime",
      `al-aaa survivor keeps key (got ${rows[0].cover_r2_key})`);
    assert(rows[1].id === "al-bbb" && rows[1].cover_r2_key === null,
      `al-bbb cleared (got ${rows[1].cover_r2_key})`);
    assert(rows[2].id === "al-ccc" && rows[2].cover_r2_key === null,
      `al-ccc cleared (got ${rows[2].cover_r2_key})`);
  }

  console.log("\nMultiple duplicate groups in one sweep:");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO albums (id, name, cover_r2_key) VALUES
        ('al-001', 'A1', 'covers/groupX'),
        ('al-002', 'A2', 'covers/groupX'),
        ('al-003', 'A3', 'covers/groupX'),
        ('al-010', 'B1', 'covers/groupY'),
        ('al-011', 'B2', 'covers/groupY'),
        ('al-020', 'C1', 'covers/uniq'),
        ('al-021', 'C2', NULL);
    `);
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { ok: boolean; groups: number; cleared: number };
    assert(body.groups === 2, `groups=2 (got ${body.groups})`);
    assert(body.cleared === 3, `cleared=3 (2 from groupX + 1 from groupY) (got ${body.cleared})`);

    // groupX: only al-001 retains.
    const x = sqlite.prepare("SELECT id FROM albums WHERE cover_r2_key='covers/groupX' ORDER BY id").all() as Array<{ id: string }>;
    assert(x.length === 1 && x[0].id === "al-001", `groupX survivor is al-001 (got ${JSON.stringify(x)})`);
    // groupY: only al-010 retains.
    const y = sqlite.prepare("SELECT id FROM albums WHERE cover_r2_key='covers/groupY' ORDER BY id").all() as Array<{ id: string }>;
    assert(y.length === 1 && y[0].id === "al-010", `groupY survivor is al-010 (got ${JSON.stringify(y)})`);
    // Unique cover untouched.
    const u = sqlite.prepare("SELECT cover_r2_key FROM albums WHERE id='al-020'").get() as { cover_r2_key: string };
    assert(u.cover_r2_key === "covers/uniq", `unique cover preserved (got ${u.cover_r2_key})`);
    // NULL row untouched.
    const n = sqlite.prepare("SELECT cover_r2_key FROM albums WHERE id='al-021'").get() as { cover_r2_key: string | null };
    assert(n.cover_r2_key === null, `NULL row stays NULL (got ${n.cover_r2_key})`);
  }

  console.log("\nNon-admin (level=2) → 403 (permissionMiddleware XML):");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO albums (id, name, cover_r2_key) VALUES
        ('al-xx', 'X1', 'covers/k1'),
        ('al-yy', 'Y1', 'covers/k1');
    `);
    const { post } = makeApp(sqlite, { username: "user", level: 2 });
    const r = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    assert(r.status === 403, `403 (got ${r.status})`);
    // the legacy JSON shape. We assert on the body text instead of trying to
    // parse JSON (which would fail).
    const text = await r.text();
    assert(text.includes("Not authorized"), `body mentions Not authorized (got "${text.slice(0, 80)}")`);

    // No mutation happened.
    const rows = sqlite.prepare("SELECT id, cover_r2_key FROM albums ORDER BY id").all() as Array<{ id: string; cover_r2_key: string | null }>;
    assert(rows.every((r) => r.cover_r2_key === "covers/k1"), "albums untouched on 403");
  }

  console.log("\nNo duplicates → ok with groups=0, cleared=0:");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO albums (id, name, cover_r2_key) VALUES
        ('al-a', 'A', 'covers/a'),
        ('al-b', 'B', 'covers/b'),
        ('al-c', 'C', NULL),
        ('al-d', 'D', NULL);
    `);
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const r = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    assert(r.status === 200, `200 (got ${r.status})`);
    const body = await r.json() as { ok: boolean; groups: number; cleared: number };
    assert(body.ok === true, "ok:true");
    assert(body.groups === 0, `groups=0 (got ${body.groups})`);
    assert(body.cleared === 0, `cleared=0 (got ${body.cleared})`);

    // Sanity: rows unchanged.
    const rows = sqlite.prepare("SELECT id, cover_r2_key FROM albums ORDER BY id").all() as Array<{ id: string; cover_r2_key: string | null }>;
    assert(rows[0].cover_r2_key === "covers/a", "al-a untouched");
    assert(rows[1].cover_r2_key === "covers/b", "al-b untouched");
    assert(rows[2].cover_r2_key === null, "al-c stays NULL");
    assert(rows[3].cover_r2_key === null, "al-d stays NULL");
  }

  console.log("\nIdempotent re-run on cleaned state:");
  {
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO albums (id, name, cover_r2_key) VALUES
        ('al-1', '1', 'covers/dup'),
        ('al-2', '2', 'covers/dup');
    `);
    const { post } = makeApp(sqlite, { username: "admin", level: 3 });
    const first = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    const firstBody = await first.json() as { groups: number; cleared: number };
    assert(firstBody.groups === 1 && firstBody.cleared === 1, "first pass: 1 group, 1 cleared");

    const second = await post("/edgesonic/maintenance/cleanupDuplicateCovers", {});
    const secondBody = await second.json() as { ok: boolean; groups: number; cleared: number };
    assert(secondBody.ok === true, "second pass ok");
    assert(secondBody.groups === 0, "second pass: no duplicates left");
    assert(secondBody.cleared === 0, "second pass: nothing cleared");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
