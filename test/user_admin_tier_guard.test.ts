// Rosmontis: "管理用户权限无权管理管理员，管理员和超管只能由超管控制" —
// manage_users (grantable down to level 1) must not be able to create,
// edit, or delete an admin (level 2) or super-admin (level 3) account, nor
// promote anyone INTO that tier. Only a level-3 caller can touch the admin
// tier. This covers the /edgesonic/users/* JSON bucket; the parallel
// /rest/{create,update,delete}User Subsonic handlers apply the identical
// guard (endpoints/subsonic/users.ts) but aren't re-tested here since the
// logic is a byte-for-byte port.
//
// Run: npx tsx test/user_admin_tier_guard.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { usersRoutes } from "../worker/src/endpoints/edgesonic/users";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boundArgs: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = unknown>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
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
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    INSERT INTO users (username, master_password, level) VALUES ('carol', 'x', 1);
    INSERT INTO users (username, master_password, level) VALUES ('dave',  'x', 1);
    INSERT INTO users (username, master_password, level) VALUES ('admin', 'x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('admin2','x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('root',  'x', 3);
    INSERT INTO users (username, master_password, level) VALUES ('root2', 'x', 3);

    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    -- Level 1 also holds manage_users here specifically to prove the tier
    -- guard applies regardless of which level the permission was granted to
    -- — the point of the feature is that manage_users alone is never
    -- sufficient for the admin tier, no matter which level holds it.
    INSERT INTO user_permissions (level, permission, enabled) VALUES (1, 'manage_users', 1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (2, 'manage_users', 1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_users', 1);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync, caller: { username: string; level: number }) {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: caller.username, level: caller.level, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", usersRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
  };
}

async function main() {
  console.log("create: level-1 manage_users caller CANNOT create a level-2 (admin) account:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "carol", level: 1 });
    const r = await post("/edgesonic/users/create", { username: "newadmin", password: "x", level: 2 });
    assert(r.status === 403, `403 (got ${r.status})`);
    const row = sqlite.prepare("SELECT * FROM users WHERE username='newadmin'").get();
    assert(!row, "no row was inserted");
  }

  console.log("\ncreate: level-2 admin (manage_users) CANNOT create a level-3 (super-admin) account either:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/create", { username: "newsuper", password: "x", level: 3 });
    assert(r.status === 403, `403 (got ${r.status})`);
  }

  console.log("\ncreate: level-3 super-admin CAN create a level-2 account:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "root", level: 3 });
    const r = await post("/edgesonic/users/create", { username: "newadmin", password: "x", level: 2 });
    assert(r.status === 200, `200 (got ${r.status})`);
    const row = sqlite.prepare("SELECT level FROM users WHERE username='newadmin'").get() as { level: number };
    assert(row.level === 2, "row inserted at level 2");
  }

  console.log("\ncreate: manage_users caller CAN still create an ordinary level-1 user (no regression):");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "carol", level: 1 });
    const r = await post("/edgesonic/users/create", { username: "newbie", password: "x", level: 1 });
    assert(r.status === 200, `200 (got ${r.status})`);
  }

  console.log("\nupdate: level-2 admin CANNOT change another admin's password:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/update", { username: "admin2", password: "newpass" });
    assert(r.status === 403, `403 (got ${r.status})`);
  }

  console.log("\nupdate: level-2 admin CANNOT promote an ordinary user into the admin tier:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/update", { username: "carol", level: 2 });
    assert(r.status === 403, `403 (got ${r.status})`);
    const row = sqlite.prepare("SELECT level FROM users WHERE username='carol'").get() as { level: number };
    assert(row.level === 1, "carol's level untouched");
  }

  console.log("\nupdate: level-2 admin CAN still edit an ordinary (level-1) user (no regression):");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/update", { username: "carol", enabled: 0 });
    assert(r.status === 200, `200 (got ${r.status})`);
  }

  console.log("\nupdate: level-3 super-admin CAN edit another admin:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "root", level: 3 });
    const r = await post("/edgesonic/users/update", { username: "admin", password: "newpass" });
    assert(r.status === 200, `200 (got ${r.status})`);
  }

  console.log("\ndelete: level-2 admin CANNOT delete another admin:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/delete", { username: "admin2" });
    assert(r.status === 403, `403 (got ${r.status})`);
    const row = sqlite.prepare("SELECT * FROM users WHERE username='admin2'").get();
    assert(!!row, "admin2 still exists");
  }

  console.log("\ndelete: level-3 super-admin CAN delete an admin:");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "root", level: 3 });
    const r = await post("/edgesonic/users/delete", { username: "admin2" });
    assert(r.status === 200, `200 (got ${r.status})`);
  }

  console.log("\ndelete: level-2 admin CAN still delete an ordinary user (no regression):");
  {
    const sqlite = buildDb();
    const { post } = makeApp(sqlite, { username: "admin", level: 2 });
    const r = await post("/edgesonic/users/delete", { username: "dave" });
    assert(r.status === 200, `200 (got ${r.status})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
