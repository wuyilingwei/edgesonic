//
// Inline label-rename for an existing Subsonic credential. Authorisation is
// pinned to the session user (UPDATE WHERE id=? AND username=?), so the
// "other user's row" case naturally surfaces as 0 changes → 404 rather than
// silently succeeding.
//
// Coverage:
//  1. Own credential, valid label → 200 ok, label persisted.
//  2. Empty string label → 200 ok, label cleared.
//  3. Someone else's credential → 404 (no row matched).
//  4. Missing id → 400.
//  5. Missing label (undefined) → 400.
//  6. label > 200 chars → 400.
//  7. Unknown id (even for own user) → 404.
//
// The test mounts edgesonicAuthRoutes under /edgesonic, sets c.user inline
// (skipping the real authMiddleware), and stubs permissionMiddleware via a
// permission row that grants manage_credentials at level 2.
//
// Run: npx tsx test/credentials_update.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { edgesonicAuthRoutes } from "../worker/src/endpoints/edgesonic/auth";

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
  return { prepare };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE subsonic_credentials (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      label TEXT DEFAULT '',
      last_used INTEGER,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_rph INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    -- Grant manage_credentials at every level the tests exercise (2 = user).
    INSERT INTO user_permissions (level, permission, enabled, max_rph)
      VALUES (2, 'manage_credentials', 1, 0);
  `);
  // Seed two users' worth of credentials.
  sqlite.prepare(
    "INSERT INTO subsonic_credentials (id, username, password, label, created_at) VALUES (?, ?, ?, ?, 1700000000)",
  ).run("cred-alice", "alice", "pw-a", "Old Phone");
  sqlite.prepare(
    "INSERT INTO subsonic_credentials (id, username, password, label, created_at) VALUES (?, ?, ?, ?, 1700000000)",
  ).run("cred-bob", "bob", "pw-b", "Bob Laptop");
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, sessionUser: { username: string; level: number }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { ...sessionUser, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", edgesonicAuthRoutes);
  const env = { DB: makeD1(sqlite), KV: { async get() { return null; }, async put() {}, async delete() {} } };
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
    async postRaw(url: string, body: string) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

function labelOf(sqlite: DatabaseSync, id: string): string | null {
  const row = sqlite.prepare("SELECT label FROM subsonic_credentials WHERE id=?").get(id) as { label: string } | undefined;
  return row ? row.label : null;
}

async function main() {
  console.log("Own credential, valid label → 200 ok + label persisted:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-alice", label: "New Phone" });
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(/status="ok"/.test(xml), "ok envelope");
    assert(/label="New Phone"/.test(xml), "label echoed");
    assert(labelOf(sqlite, "cred-alice") === "New Phone", "label persisted to DB");
  }

  console.log("\nEmpty string label clears the label:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-alice", label: "" });
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(labelOf(sqlite, "cred-alice") === "", "label cleared (empty string)");
  }

  console.log("\nOther user's credential → 404, no mutation:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-bob", label: "Hacked" });
    assert(r.status === 404, `404 (got ${r.status})`);
    const xml = await r.text();
    assert(/status="failed"/.test(xml) && /code="70"/.test(xml), "failed envelope code=70");
    assert(labelOf(sqlite, "cred-bob") === "Bob Laptop", "bob's label intact");
  }

  console.log("\nMissing id → 400:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { label: "x" });
    assert(r.status === 400, `400 (got ${r.status})`);
    const xml = await r.text();
    assert(/status="failed"/.test(xml), "failed envelope");
    assert(/Missing credential id/.test(xml), "explains missing id");
  }

  console.log("\nMissing label (undefined) → 400:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-alice" });
    assert(r.status === 400, `400 (got ${r.status})`);
    const xml = await r.text();
    assert(/Missing label/.test(xml), "explains missing label");
    assert(labelOf(sqlite, "cred-alice") === "Old Phone", "alice's label intact on 400");
  }

  console.log("\nLabel > 200 chars → 400:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const oversized = "x".repeat(201);
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-alice", label: oversized });
    assert(r.status === 400, `400 (got ${r.status})`);
    const xml = await r.text();
    assert(/Label too long/.test(xml), "explains label too long");
    assert(labelOf(sqlite, "cred-alice") === "Old Phone", "alice's label intact on 400");
  }

  console.log("\nUnknown id for own user → 404:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "alice", level: 2 });
    const r = await post("/edgesonic/auth/credentials/update", { id: "cred-ghost", label: "x" });
    assert(r.status === 404, `404 (got ${r.status})`);
    const xml = await r.text();
    assert(/code="70"/.test(xml), "code=70");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
