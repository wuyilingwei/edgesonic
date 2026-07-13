//
// Coverage:
//  * getOpenSubsonicExtensions returns the three advertised extensions
//  * tokenInfo echoes the authenticated user + level + permissions
//  * changePassword: self → 200, non-admin → 403, admin → 200, missing user → 404
//  * mapAlbum / mapArtist / mapSong field back-fill is opt-in (annotation arg)
//
// Same harness style as test/annotation.test.ts: an in-memory SQLite wrapped
// in a tiny D1Database shim, the production handlers driven via Hono.fetch.
//
// Run: npx tsx test/opensubsonic/opensubsonic.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { openSubsonicRoutes } from "../../worker/src/endpoints/subsonic/opensubsonic";
import { accountRoutes } from "../../worker/src/endpoints/subsonic/account";
import { mapAlbum, mapArtist, mapSong } from "../../worker/src/types/subsonic";
import { sha256 } from "../../worker/src/auth";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) {
        boundArgs = args;
        return this;
      },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

async function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      avatar_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE features (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, description TEXT, updated_at INTEGER DEFAULT 0);
    CREATE TABLE feature_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT, updated_at INTEGER DEFAULT 0);
    INSERT INTO features (key, value) VALUES ('allow_being_proxied', 1);
  `);

  // alice = regular user (level 2); bob = admin (level 3); carol = guest (level 1)
  const pwAlice = await sha256("alice-pw");
  const pwBob = await sha256("bob-pw");
  const pwCarol = await sha256("carol-pw");

  sqlite.prepare("INSERT INTO users (username, master_password, level) VALUES (?, ?, ?)").run("alice", pwAlice, 2);
  sqlite.prepare("INSERT INTO users (username, master_password, level) VALUES (?, ?, ?)").run("bob", pwBob, 3);
  sqlite.prepare("INSERT INTO users (username, master_password, level) VALUES (?, ?, ?)").run("carol", pwCarol, 1);

  sqlite.exec(`
    INSERT INTO user_permissions VALUES (2, 'browse',           1, 0);
    INSERT INTO user_permissions VALUES (2, 'stream',           1, 0);
    INSERT INTO user_permissions VALUES (2, 'edit_annotations', 1, 0);
    INSERT INTO user_permissions VALUES (3, 'browse',           1, 0);
    INSERT INTO user_permissions VALUES (3, 'stream',           1, 0);
    INSERT INTO user_permissions VALUES (3, 'manage_users',     1, 0);
    INSERT INTO user_permissions VALUES (1, 'browse',           1, 0);
  `);

  return sqlite;
}

// Hono harness — injects user before sub-routes run.
function makeApp(sqlite: DatabaseSync, asUsername: string, asLevel: number, mountAdmin = false) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: asUsername, level: asLevel, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/rest", openSubsonicRoutes);
  if (mountAdmin) app.route("/rest", accountRoutes);
  const env: any = { DB: makeD1(sqlite), INSTANCE_ID: "inst-uuid-1234", KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
  return {
    async hit(method: "GET" | "POST", url: string, body?: any) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "Content-Type": "application/json" };
      }
      return app.fetch(new Request(`http://test${url}`, init), env);
    },
  };
}

function xmlHas(xml: string, fragment: string): boolean {
  return xml.includes(fragment);
}
function statusOK(xml: string): boolean {
  return xml.includes('status="ok"');
}
function statusFailed(xml: string): boolean {
  return xml.includes('status="failed"');
}

async function main() {
  // =========================================================================
  // Extensions endpoint
  // =========================================================================
  console.log("endpoint: getOpenSubsonicExtensions");
  {
    const sqlite = await buildDb();
    const { hit } = makeApp(sqlite, "alice", 2);

    const r = await hit("GET", "/rest/getOpenSubsonicExtensions");
    const body = await r.text();
    assert(r.status === 200 && statusOK(body), "200 ok status");
    assert(xmlHas(body, "<openSubsonicExtensions"), "<openSubsonicExtensions> wrapper");
    assert(xmlHas(body, 'name="apiKeyAuthentication"'), "advertises apiKeyAuthentication");
    assert(xmlHas(body, 'name="tokenInfo"'), "advertises tokenInfo");
    assert(xmlHas(body, 'name="formPost"'), "advertises formPost");
    // structuredLyrics, and clients only call it when the extension is declared.
    assert(xmlHas(body, 'name="songLyrics"'), "advertises songLyrics (108)");
    assert(xmlHas(body, 'name="edgeSonicCloneProxy"'), "advertises EdgeSonic clone proxy capability");
    assert(xmlHas(body, 'proxy="true"'), "declares clone proxy support");
    assert(xmlHas(body, 'autoMerge="true"'), "declares automatic merge support");
    assert(xmlHas(body, 'fuzzyMerge="true"'), "declares fuzzy merge support");
    // shape), so the JSON conversion yields "versions":[1] as a number array.
    assert(xmlHas(body, "<versions>1</versions>"), "versions emitted as child elements");
    assert(!xmlHas(body, 'versions="'), "no legacy versions attribute");
    // 178 (#254): S2S relay policy + loop-prevention UUID at the response root.
    assert(xmlHas(body, 'server_relay_policy="allow"'), "advertises server_relay_policy=allow (derived from allow_being_proxied=1)");
    assert(xmlHas(body, 'server_uuid="inst-uuid-1234"'), "advertises server_uuid = INSTANCE_ID");

    // .view alias works
    const r2 = await hit("GET", "/rest/getOpenSubsonicExtensions.view");
    assert(r2.status === 200 && statusOK(await r2.text()), ".view alias OK");

    // POST works (formPost extension self-consistency)
    const r3 = await hit("POST", "/rest/getOpenSubsonicExtensions");
    assert(r3.status === 200 && statusOK(await r3.text()), "POST works (formPost)");
  }

  // =========================================================================
  // tokenInfo endpoint
  // =========================================================================
  console.log("endpoint: tokenInfo");
  {
    const sqlite = await buildDb();
    const { hit } = makeApp(sqlite, "alice", 2);

    const r = await hit("GET", "/rest/tokenInfo");
    const body = await r.text();
    assert(r.status === 200 && statusOK(body), "tokenInfo 200 ok");
    assert(xmlHas(body, 'username="alice"'), "echoes username");
    assert(xmlHas(body, 'level="2"'), "echoes level");
    assert(xmlHas(body, 'name="browse"'), "permission row for browse emitted");
    assert(xmlHas(body, 'name="edit_annotations"'), "permission row for edit_annotations emitted");
    assert(!xmlHas(body, 'name="manage_users"'), "level-2 permissions don't include manage_users");

    const r2 = await hit("POST", "/rest/tokenInfo.view");
    assert(r2.status === 200, "POST .view variant works");

    // Admin sees admin-only perms
    const { hit: hitAdmin } = makeApp(sqlite, "bob", 3);
    const rAdmin = await hitAdmin("GET", "/rest/tokenInfo");
    const adminBody = await rAdmin.text();
    assert(xmlHas(adminBody, 'username="bob"'), "admin tokenInfo echoes bob");
    assert(xmlHas(adminBody, 'name="manage_users"'), "admin tokenInfo lists manage_users");
  }

  // =========================================================================
  // changePassword endpoint
  // =========================================================================
  console.log("endpoint: changePassword");
  {
    const sqlite = await buildDb();
    const oldAliceHash = sqlite.prepare("SELECT master_password AS p FROM users WHERE username='alice'").get() as any;

    // alice → alice (self): OK
    const { hit } = makeApp(sqlite, "alice", 2, true);
    const r1 = await hit("GET", "/rest/changePassword?username=alice&password=new-alice-pw");
    const body1 = await r1.text();
    assert(r1.status === 200 && statusOK(body1), "alice changes own password OK");
    const newAlice = sqlite.prepare("SELECT master_password AS p FROM users WHERE username='alice'").get() as any;
    assert(newAlice.p !== oldAliceHash.p, "alice's password hash changed");
    assert(newAlice.p === await sha256("new-alice-pw"), "alice's password hash matches expected SHA-256");

    // alice → carol (other, non-admin): 403
    const r2 = await hit("POST", "/rest/changePassword", { username: "carol", password: "hijack" });
    assert(r2.status === 403 && statusFailed(await r2.text()), "alice cannot change carol's password (403)");
    const carolUntouched = sqlite.prepare("SELECT master_password AS p FROM users WHERE username='carol'").get() as any;
    assert(carolUntouched.p === await sha256("carol-pw"), "carol's password untouched");

    // bob (admin level 3) → carol: OK
    const { hit: hitBob } = makeApp(sqlite, "bob", 3, true);
    const r3 = await hitBob("POST", "/rest/changePassword", { username: "carol", password: "admin-reset" });
    assert(r3.status === 200 && statusOK(await r3.text()), "admin (bob) changes carol's password OK");
    const carolAfter = sqlite.prepare("SELECT master_password AS p FROM users WHERE username='carol'").get() as any;
    assert(carolAfter.p === await sha256("admin-reset"), "carol's password reset by admin");

    // Missing param → 400
    const r4 = await hit("GET", "/rest/changePassword");
    assert(r4.status === 400 && statusFailed(await r4.text()), "missing params → 400");

    // Non-existent user as admin → 404
    const r5 = await hitBob("POST", "/rest/changePassword", { username: "nope", password: "x" });
    assert(r5.status === 404 && statusFailed(await r5.text()), "non-existent target → 404");
  }

  // =========================================================================
  // mapXxx field back-fill
  // =========================================================================
  console.log("unit: mapAlbum / mapArtist / mapSong annotation back-fill");
  {
    const artist = {
      id: "ar-1", name: "Artist One", sort_name: null, image_r2_key: null,
      created_at: 0, updated_at: 0,
    };
    const album = {
      id: "al-1", name: "Album One", sort_name: null, year: 2020, genre: "Rock",
      cover_r2_key: null, song_count: 10, duration: 3000, size: 0,
      compilation: 0, created_at: 1700000000, updated_at: 0,
    };
    const song = {
      id: "sg-1", album_id: "al-1", artist_id: "ar-1", album_artist_id: null,
      title: "Song One", sort_title: null, track: 1, disc: 1, duration: 200,
      genre: "Rock", compilation: 0, participants: null, created_at: 0, updated_at: 0,
    };

    // No annotation → fields absent
    const a0 = mapArtist(artist);
    const al0 = mapAlbum(album);
    const s0 = mapSong(song, "al-1");
    assert(a0.starred === undefined && a0.userRating === undefined && a0.playCount === undefined,
      "mapArtist no-ann: starred/userRating/playCount all undefined (back-compat)");
    assert(al0.starred === undefined && al0.userRating === undefined && al0.playCount === undefined,
      "mapAlbum no-ann: starred/userRating/playCount all undefined");
    assert(s0.starred === undefined && s0.userRating === undefined && s0.playCount === undefined,
      "mapSong no-ann: starred/userRating/playCount all undefined");

    // Full annotation → all three injected
    const ann = { starred: 1, starred_at: 1700000000, rating: 4, play_count: 7 };
    const a1 = mapArtist(artist, ann);
    const al1 = mapAlbum(album, "Artist One", ann);
    const s1 = mapSong(song, "al-1", ann);
    assert(typeof a1.starred === "string" && a1.starred.startsWith("20"), `mapArtist starred is ISO string: ${a1.starred}`);
    assert(a1.userRating === 4, "mapArtist userRating = 4");
    assert(a1.playCount === 7, "mapArtist playCount = 7");
    assert(al1.starred && al1.userRating === 4 && al1.playCount === 7, "mapAlbum back-fill full");
    assert(s1.starred && s1.userRating === 4 && s1.playCount === 7, "mapSong back-fill full");
    assert(al1.artist === "Artist One", "mapAlbum back-fill preserves artist arg");

    // Partial: starred=0 but rating + plays present → starred omitted
    const annNotStarred = { starred: 0, starred_at: null, rating: 3, play_count: 2 };
    const a2 = mapAlbum(album, undefined, annNotStarred);
    assert(a2.starred === undefined, "starred=0 omits starred field");
    assert(a2.userRating === 3, "starred=0 still emits userRating");
    assert(a2.playCount === 2, "starred=0 still emits playCount");

    // rating null + play_count 0 → both omitted
    const annEmpty = { starred: 0, starred_at: null, rating: null, play_count: 0 };
    const a3 = mapAlbum(album, undefined, annEmpty);
    assert(a3.userRating === undefined && a3.playCount === undefined,
      "empty annotation row → no fields emitted");
  }
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
