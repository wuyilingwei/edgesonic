// Guest token TTL cap + hardlock read-time enforcement tests.
// Covers task 258:
//  - POST /edgesonic/auth/guestToken caps expiresIn at 30 days, rejects <=0,
//    clamps >cap to the cap.
//  - hasPermission enforces hardlock even with a stale PERMISSIONS_OVERRIDE
//    that tries to grant a locked perm.
//  - getEffectivePermissions masks any hardlocked perm that slipped through
//    D1 (defensive: a stray SQL edit cannot surface as a real capability).
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware, GUEST_USERNAME, SESSION_TTL_SEC, buildSessionCookieHeader } from "../../worker/src/auth";
import { webLoginRoutes, edgesonicAuthRoutes } from "../../worker/src/endpoints/edgesonic/auth";
import {
  getEffectivePermissions,
  hasPermission,
  isPermissionHardlocked,
  GUEST_ALLOWED_PERMS,
  USER_LOCKED_PERMS,
} from "../../worker/src/utils/permissions";

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
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER NOT NULL, enabled INTEGER DEFAULT 1);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, token TEXT NOT NULL, user_agent TEXT, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE subsonic_credentials (username TEXT NOT NULL, password TEXT NOT NULL, stream_proxy_strategy TEXT, last_used INTEGER);
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER DEFAULT 0);
    INSERT INTO users (username, master_password, level, enabled) VALUES ('admin','h',3,1),('alice','h',1,1),('guest','',0,1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (0,'stream',1),(0,'browse',1),(0,'search',1),
      (1,'stream',1),(1,'download',1),(1,'browse',1),(1,'search',1),
      (2,'stream',1),(2,'download',1),(2,'browse',1),
      (3,'stream',1),(3,'download',1);
  `);
  return sqlite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAuthApp(sqlite: DatabaseSync, caller: { username: string; level: number }): any {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", caller); c.set("authMethod", "session"); c.set("authSource", "cookie"); return next(); });
  app.route("/edgesonic", edgesonicAuthRoutes);
  const env = { DB: makeD1(sqlite), INSTANCE_ID: "test" };
  return {
    async postGuestToken(body: { expiresIn?: number }) {
      return app.fetch(new Request("http://test/edgesonic/auth/guestToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }), env as any);
    },
  };
}

async function main() {
  console.log("Hardlock set composition:");
  {
    assert(GUEST_ALLOWED_PERMS.size === 3, "guest allowed perms = 3");
    assert(GUEST_ALLOWED_PERMS.has("stream"), "guest allowed stream");
    assert(GUEST_ALLOWED_PERMS.has("browse"), "guest allowed browse");
    assert(GUEST_ALLOWED_PERMS.has("search"), "guest allowed search");
    assert(USER_LOCKED_PERMS.has("manage_users"), "user locked manage_users");
    assert(USER_LOCKED_PERMS.has("manage_credentials"), "user locked manage_credentials");
    assert(USER_LOCKED_PERMS.has("maintenance_cleanup"), "user locked maintenance_cleanup");
  }

  console.log("\nisPermissionHardlocked:");
  {
    assert(isPermissionHardlocked(0, "stream") === false, "guest stream not locked");
    assert(isPermissionHardlocked(0, "browse") === false, "guest browse not locked");
    assert(isPermissionHardlocked(0, "download") === true, "guest download locked");
    assert(isPermissionHardlocked(0, "edit_tags") === true, "guest edit_tags locked");
    assert(isPermissionHardlocked(0, "manage_users") === true, "guest manage_users locked");
    assert(isPermissionHardlocked(1, "stream") === false, "user stream not locked");
    assert(isPermissionHardlocked(1, "download") === false, "user download not locked");
    assert(isPermissionHardlocked(1, "manage_users") === true, "user manage_users locked");
    assert(isPermissionHardlocked(1, "manage_settings") === true, "user manage_settings locked");
    assert(isPermissionHardlocked(2, "manage_users") === false, "admin manage_users not locked (delegatable)");
    assert(isPermissionHardlocked(3, "anything") === false, "super admin not locked (short-circuited)");
  }

  console.log("\nhasPermission: level 3 short-circuit ignores hardlock:");
  {
    const sqlite = buildDb();
    const env = { DB: makeD1(sqlite) };
    // No D1 row needed — super admin short-circuits to true.
    assert(await hasPermission(env, { level: 3 }, "manage_users") === true, "L3 manage_users=true");
    assert(await hasPermission(env, { level: 3 }, "anything_not_in_table") === true, "L3 unknown perm=true");
  }

  console.log("\nhasPermission: guest hardlocked from edit_tags even with override=true:");
  {
    const sqlite = buildDb();
    // Insert a stray enabled=1 row that would normally grant edit_tags to guest.
    sqlite.prepare("INSERT INTO user_permissions (level, permission, enabled) VALUES (0, 'edit_tags', 1)").run();
    const envNoOverride = { DB: makeD1(sqlite) };
    assert(await hasPermission(envNoOverride, { level: 0 }, "edit_tags") === false, "guest edit_tags=false despite D1 enabled (read-time guard)");
    // Even with an override that says true, hardlock wins.
    const envWithOverride = {
      DB: makeD1(sqlite),
      PERMISSIONS_OVERRIDE: JSON.stringify({ "0": { "edit_tags": true } }),
    };
    assert(await hasPermission(envWithOverride, { level: 0 }, "edit_tags") === false, "guest edit_tags=false even with override=true");
    // Allowed perms still flow through.
    assert(await hasPermission(envNoOverride, { level: 0 }, "stream") === true, "guest stream=true");
    assert(await hasPermission(envWithOverride, { level: 0 }, "browse") === true, "guest browse=true with override");
  }

  console.log("\nhasPermission: user hardlocked from manage_users even with override=true:");
  {
    const sqlite = buildDb();
    sqlite.prepare("INSERT INTO user_permissions (level, permission, enabled) VALUES (1, 'manage_users', 1)").run();
    const envNoOverride = { DB: makeD1(sqlite) };
    assert(await hasPermission(envNoOverride, { level: 1 }, "manage_users") === false, "user manage_users=false despite D1 enabled");
    const envWithOverride = {
      DB: makeD1(sqlite),
      PERMISSIONS_OVERRIDE: JSON.stringify({ "1": { "manage_users": true } }),
    };
    assert(await hasPermission(envWithOverride, { level: 1 }, "manage_users") === false, "user manage_users=false even with override=true");
    // Non-locked user perms still pass.
    assert(await hasPermission(envNoOverride, { level: 1 }, "download") === true, "user download=true");
  }

  console.log("\ngetEffectivePermissions: masks hardlocked perms that slipped through D1:");
  {
    const sqlite = buildDb();
    sqlite.prepare("INSERT INTO user_permissions (level, permission, enabled) VALUES (0, 'edit_tags', 1), (1, 'manage_settings', 1)").run();
    const env = { DB: makeD1(sqlite) };
    const guestPerms = await getEffectivePermissions(env, { level: 0 } as any);
    assert(guestPerms["edit_tags"] === false, "effective guest edit_tags=false");
    assert(guestPerms["stream"] === true, "effective guest stream=true");
    assert(guestPerms["manage_permissions"] === false, "effective guest manage_permissions=false");
    const userPerms = await getEffectivePermissions(env, { level: 1 } as any);
    assert(userPerms["manage_settings"] === false, "effective user manage_settings=false");
    assert(userPerms["download"] === true, "effective user download=true");
  }

  console.log("\ngetEffectivePermissions: override cannot unlock hardlocked perms:");
  {
    const sqlite = buildDb();
    const env = {
      DB: makeD1(sqlite),
      PERMISSIONS_OVERRIDE: JSON.stringify({
        "0": { "edit_tags": true, "stream": true },
        "1": { "manage_users": true, "download": true },
      }),
    };
    const guestPerms = await getEffectivePermissions(env, { level: 0 } as any);
    assert(guestPerms["edit_tags"] === false, "override cannot unlock guest edit_tags");
    assert(guestPerms["stream"] === true, "override can still set guest stream=true");
    const userPerms = await getEffectivePermissions(env, { level: 1 } as any);
    assert(userPerms["manage_users"] === false, "override cannot unlock user manage_users");
    assert(userPerms["download"] === true, "override can still set user download=true");
  }

  console.log("\nPOST /edgesonic/auth/guestToken: default TTL = 1 day, capped at 30 days:");
  {
    const sqlite = buildDb();
    const app = makeAuthApp(sqlite, { username: "admin", level: 3 });
    const before = Math.floor(Date.now() / 1000);

    // Default (no expiresIn) → ~1 day.
    const r1 = await app.postGuestToken({});
    assert(r1.status === 200, `default 200 (got ${r1.status})`);
    const body1 = await r1.text();
    const exp1 = parseInt(body1.match(/expiresAt="(\d+)"/)?.[1] || "0");
    assert(exp1 - before >= 86390 && exp1 - before <= 86410, `default TTL ~1d (got delta ${exp1 - before})`);

    // Explicit 7 days → accepted.
    const r2 = await app.postGuestToken({ expiresIn: 7 * 86400 });
    assert(r2.status === 200, `7d 200 (got ${r2.status})`);
    const body2 = await r2.text();
    const exp2 = parseInt(body2.match(/expiresAt="(\d+)"/)?.[1] || "0");
    assert(exp2 - before >= 7 * 86390 && exp2 - before <= 7 * 86410, `7d TTL (got delta ${exp2 - before})`);

    // Over cap (1 year) → clamped to 30 days.
    const r3 = await app.postGuestToken({ expiresIn: 365 * 86400 });
    assert(r3.status === 200, `over-cap 200 (got ${r3.status})`);
    const body3 = await r3.text();
    const exp3 = parseInt(body3.match(/expiresAt="(\d+)"/)?.[1] || "0");
    const delta3 = exp3 - before;
    assert(delta3 <= 30 * 86400 + 5, `over-cap clamped to 30d (got delta ${delta3})`);
    assert(delta3 > 29 * 86400, `over-cap clamped to ~30d (got delta ${delta3})`);

    // 0 / negative → 400. (NaN cannot be expressed in JSON — JSON.stringify
    // turns it into null, which the API correctly treats as "use the default";
    // we don't bother testing that path here.)
    const r4 = await app.postGuestToken({ expiresIn: 0 });
    assert(r4.status === 400, `expiresIn=0 → 400 (got ${r4.status})`);
    const r5 = await app.postGuestToken({ expiresIn: -100 });
    assert(r5.status === 400, `expiresIn<0 → 400 (got ${r5.status})`);

    // Non-numeric string sent as JSON also lands as the default (JSON.parse
    // would fail first if the body weren't valid JSON). Confirm a string
    // payload doesn't sneak through as NaN/Infinity — JSON has no such
    // numbers, and typeof === "number" gate excludes them.
    const r6 = await app.postGuestToken({ expiresIn: "999999999" as unknown as number });
    assert(r6.status === 200, `string expiresIn falls back to default (got ${r6.status})`);
  }

  console.log("\nALL PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });