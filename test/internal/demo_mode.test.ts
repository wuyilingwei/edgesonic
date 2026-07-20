// Demo mode enforcement tests.
// Covers:
//  - hasPermission / getEffectivePermissions force dangerous perms off for
//    every level (including 3) when DEMO_MODE="1".
//  - /rest/changePassword rejects superadmin password rotation in demo mode
//    but still allows admin/user self-password rotation.
//  - /edgesonic/features/update + /features/updateString reject locked keys
//    in demo mode.
//  - Non-demo mode (DEMO_MODE unset or != "1") preserves existing behaviour.
//  - demoMaxUploadBytes reads DEMO_MAX_UPLOAD_BYTES correctly.
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import {
  getEffectivePermissions,
  hasPermission,
} from "../../worker/src/utils/permissions";
import {
  isDemoMode,
  isDemoDisabledPerm,
  isDemoLockedFeature,
  demoMaxUploadBytes,
  DEMO_DISABLED_PERMS,
} from "../../worker/src/utils/demoMode";
import { accountRoutes } from "../../worker/src/endpoints/subsonic/account";
import { featuresRoutes } from "../../worker/src/endpoints/edgesonic/features";

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

function fail(msg: string): never { console.error("FAIL:", msg); process.exit(1); }
function assert(cond: boolean, msg: string) { if (!cond) fail(msg); }

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER NOT NULL, enabled INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 0);
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER, description TEXT, updated_at INTEGER);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at INTEGER);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('super','h',3,1),('alice','h',1,1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (0,'stream',1),(0,'browse',1),(0,'search',1),
      (1,'stream',1),(1,'download',1),(1,'browse',1),(1,'search',1),
      (2,'stream',1),(2,'download',1),(2,'browse',1),(2,'manage_users',1),
      (3,'stream',1),(3,'download',1),(3,'manage_cloudflare',1),(3,'dispatch_work',1),(3,'delete',1);
    INSERT INTO features (key, value, description, updated_at) VALUES
      ('enable_r2_presign', 1, '', 0),
      ('worker_pool_enabled', 1, '', 0);
    INSERT INTO feature_strings (key, value, description, updated_at) VALUES
      ('transcode_engine', 'browser_pool', '', 0),
      ('scan_interval_hours', '24', '', 0);
  `);
  return sqlite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAccountApp(sqlite: DatabaseSync, caller: { username: string; level: number }, env: any, target: string) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", caller); c.set("authMethod", "session"); c.set("authSource", "cookie"); return next(); });
  app.route("/rest", accountRoutes);
  return app.fetch(new Request(`http://test/rest/changePassword?username=${target}&password=newpw`, { method: "GET" }), env);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFeaturesApp(sqlite: DatabaseSync, caller: { username: string; level: number }, env: any) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", caller); c.set("authMethod", "session"); c.set("authSource", "cookie"); return next(); });
  app.route("/edgesonic", featuresRoutes);
  return app;
}

async function main() {
  console.log("isDemoMode / isDemoDisabledPerm / isDemoLockedFeature / demoMaxUploadBytes:");
  {
    assert(isDemoMode({}) === false, "no env → not demo");
    assert(isDemoMode({ DEMO_MODE: "" }) === false, "empty → not demo");
    assert(isDemoMode({ DEMO_MODE: "0" }) === false, "0 → not demo");
    assert(isDemoMode({ DEMO_MODE: "1" }) === true, "1 → demo");
    assert(isDemoMode({ DEMO_MODE: " 1 " }) === true, "whitespace 1 → demo");

    for (const p of DEMO_DISABLED_PERMS) {
      assert(isDemoDisabledPerm(p), `${p} disabled in demo`);
    }
    assert(isDemoDisabledPerm("stream") === false, "stream not disabled");
    assert(isDemoDisabledPerm("browse") === false, "browse not disabled");
    assert(isDemoDisabledPerm("edit_tags") === false, "edit_tags not disabled");

    assert(isDemoLockedFeature("transcode_engine"), "transcode_engine locked");
    assert(isDemoLockedFeature("enable_r2_presign"), "enable_r2_presign locked");
    assert(isDemoLockedFeature("worker_pool_enabled"), "worker_pool_enabled locked");
    assert(isDemoLockedFeature("scan_interval_hours"), "scan_interval_hours locked");
    assert(isDemoLockedFeature("lastfm_api_key") === false, "lastfm_api_key not locked (operator can rotate)");
    assert(isDemoLockedFeature("r2_free_allocation_gb") === false, "r2_free_allocation_gb not locked");

    assert(demoMaxUploadBytes({}) === 50 * 1024 * 1024, "default cap 50 MiB");
    assert(demoMaxUploadBytes({ DEMO_MAX_UPLOAD_BYTES: "1048576" }) === 1024 * 1024, "override 1 MiB");
    assert(demoMaxUploadBytes({ DEMO_MAX_UPLOAD_BYTES: "999999999999" }) === 256 * 1024 * 1024, "capped at 256 MiB");
    assert(demoMaxUploadBytes({ DEMO_MAX_UPLOAD_BYTES: "abc" }) === 50 * 1024 * 1024, "invalid → default");
  }

  console.log("\nhasPermission: demo forces disabled perms off even for level 3:");
  {
    const sqlite = buildDb();
    const envDemo = { DB: makeD1(sqlite), DEMO_MODE: "1" };
    assert(await hasPermission(envDemo, { level: 3 }, "manage_cloudflare") === false, "demo L3 manage_cloudflare=false");
    assert(await hasPermission(envDemo, { level: 3 }, "dispatch_work") === false, "demo L3 dispatch_work=false");
    assert(await hasPermission(envDemo, { level: 3 }, "delete") === false, "demo L3 delete=false");
    assert(await hasPermission(envDemo, { level: 3 }, "maintenance_cleanup") === false, "demo L3 maintenance_cleanup=false");
    assert(await hasPermission(envDemo, { level: 3 }, "manage_users") === false, "demo L3 manage_users=false");
    assert(await hasPermission(envDemo, { level: 3 }, "manage_sources") === false, "demo L3 manage_sources=false");
    // Non-disabled perms still flow through level 3 short-circuit.
    assert(await hasPermission(envDemo, { level: 3 }, "stream") === true, "demo L3 stream=true");
    assert(await hasPermission(envDemo, { level: 3 }, "manage_settings") === true, "demo L3 manage_settings=true");
    assert(await hasPermission(envDemo, { level: 3 }, "edit_tags") === true, "demo L3 edit_tags=true");
    assert(await hasPermission(envDemo, { level: 3 }, "manage_permissions") === true, "demo L3 manage_permissions=true (hardcoded)");

    const envNoDemo = { DB: makeD1(sqlite) };
    assert(await hasPermission(envNoDemo, { level: 3 }, "manage_cloudflare") === true, "non-demo L3 manage_cloudflare=true");
    assert(await hasPermission(envNoDemo, { level: 3 }, "dispatch_work") === true, "non-demo L3 dispatch_work=true");
  }

  console.log("\ngetEffectivePermissions: demo masks disabled perms on every level:");
  {
    const sqlite = buildDb();
    const envDemo = { DB: makeD1(sqlite), DEMO_MODE: "1" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const superPerms = await getEffectivePermissions(envDemo, { level: 3 } as any);
    assert(superPerms["manage_cloudflare"] === false, "effective demo L3 manage_cloudflare=false");
    assert(superPerms["dispatch_work"] === false, "effective demo L3 dispatch_work=false");
    assert(superPerms["delete"] === false, "effective demo L3 delete=false");
    assert(superPerms["manage_users"] === false, "effective demo L3 manage_users=false");
    assert(superPerms["stream"] === true, "effective demo L3 stream=true");
    assert(superPerms["manage_settings"] === true, "effective demo L3 manage_settings=true");

    const envNoDemo = { DB: makeD1(sqlite) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const superPermsNoDemo = await getEffectivePermissions(envNoDemo, { level: 3 } as any);
    assert(superPermsNoDemo["manage_cloudflare"] === true, "effective non-demo L3 manage_cloudflare=true");
  }

  console.log("\n/rest/changePassword: demo locks superadmin rotation, admin/user still can:");
  {
    const sqlite = buildDb();
    const envDemo = { DB: makeD1(sqlite), DEMO_MODE: "1" };
    // Super-admin (caller level 3) trying to rotate own password → 403.
    const r1 = await makeAccountApp(sqlite, { username: "super", level: 3 }, envDemo, "super");
    assert(r1.status === 403, `demo super self changePassword → 403 (got ${r1.status})`);
    const body1 = await r1.text();
    assert(body1.includes("demo mode"), "demo rejection body mentions demo mode");

    // Non-demo: same call → 200.
    const envNoDemo = { DB: makeD1(sqlite) };
    const r2 = await makeAccountApp(sqlite, { username: "super", level: 3 }, envNoDemo, "super");
    assert(r2.status === 200, `non-demo super self changePassword → 200 (got ${r2.status})`);

    // Demo: user rotating their own password → 200 (not locked).
    const r3 = await makeAccountApp(sqlite, { username: "alice", level: 1 }, envDemo, "alice");
    assert(r3.status === 200, `demo user self changePassword → 200 (got ${r3.status})`);
  }

  console.log("\n/edgesonic/features/update: demo rejects locked feature keys:");
  {
    const sqlite = buildDb();
    const envDemo = { DB: makeD1(sqlite), DEMO_MODE: "1" };
    const app = makeFeaturesApp(sqlite, { username: "super", level: 3 }, envDemo);

    // Locked feature → 403.
    const r1 = await app.fetch(new Request("http://test/edgesonic/features/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "enable_r2_presign", value: 0 }),
    }), envDemo);
    assert(r1.status === 403, `demo update locked feature → 403 (got ${r1.status})`);

    // Non-locked feature (lastfm_api_key is a feature_string, not boolean, so
    // use a string endpoint).
    const r2 = await app.fetch(new Request("http://test/edgesonic/features/updateString", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "lastfm_api_key", value: "abc123" }),
    }), envDemo);
    // lastfm_api_key is in STRING_FEATURE_KEYS but NOT in DEMO_LOCKED_FEATURE_KEYS,
    // so demo mode should allow it. It needs manage_settings permission
    // though; super admin has it via level 3 short-circuit.
    assert(r2.status !== 403, `demo updateString lastfm_api_key not 403 (got ${r2.status})`);

    // Locked string feature → 403.
    const r3 = await app.fetch(new Request("http://test/edgesonic/features/updateString", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "transcode_engine", value: "disabled" }),
    }), envDemo);
    assert(r3.status === 403, `demo updateString locked → 403 (got ${r3.status})`);

    // Non-demo: locked feature update → 200 (only manage_settings check).
    const envNoDemo = { DB: makeD1(sqlite) };
    const r4 = await app.fetch(new Request("http://test/edgesonic/features/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "enable_r2_presign", value: 0 }),
    }), envNoDemo);
    assert(r4.status !== 403, `non-demo update locked feature not 403 (got ${r4.status})`);
  }

  console.log("\nRegression: non-demo hasPermission unchanged on disabled perms for L3:");
  {
    const sqlite = buildDb();
    const envNoDemo = { DB: makeD1(sqlite) };
    assert(await hasPermission(envNoDemo, { level: 3 }, "manage_cloudflare") === true, "non-demo L3 manage_cloudflare=true");
    assert(await hasPermission(envNoDemo, { level: 3 }, "delete") === true, "non-demo L3 delete=true");
  }

  console.log("\nALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });