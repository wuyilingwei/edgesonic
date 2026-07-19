// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// 176: graded clone permissions + chunked (append) playlist/starred writes.
//
// Coverage:
//  1. upsertStarred to your own account works for a plain user (no manage_users).
//  2. upsertStarred to a DIFFERENT user is 403 without manage_users, 200 with it.
//  3. upsertPlaylist append mode accumulates entries (replace → append → append)
//     with contiguous positions; a fresh non-append call replaces.
//  4. upsertPlaylist to another owner needs manage_users.
//  5. upsertUser is super-admin only (403 for level 2 even with manage_users).
//
// Run: npx tsx test/internal/clone_graded_permissions.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { cloneRoutes } from "../../worker/src/endpoints/edgesonic/clone";

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
    let bound: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { bound = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> { return (stmt.get(...bound) ?? null) as T | null; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>() { return { results: stmt.all(...bound) as T[], success: true, meta: {} }; },
      async run() { const i = stmt.run(...bound); return { success: true, meta: { changes: Number(i.changes ?? 0) } }; },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT NOT NULL, level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, lyrics TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE annotations (user_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL CHECK (item_type IN ('song','album','artist')), play_count INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, starred_at INTEGER, PRIMARY KEY (user_id, item_id, item_type));
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, public INTEGER DEFAULT 0, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, comment TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE playlist_songs (playlist_id TEXT NOT NULL, song_master_id TEXT NOT NULL, position INTEGER NOT NULL, added_at INTEGER DEFAULT 0, PRIMARY KEY (playlist_id, position));

    INSERT INTO users (username, master_password, level) VALUES ('alice','h',1),('bob','h',1),('carol','h',2),('admin','h',3);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_users', 1);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar1','A','a');
    INSERT INTO albums (id, name, sort_name) VALUES ('al1','Al','al');
    INSERT INTO song_masters (id, album_id, artist_id, title, duration) VALUES
      ('s1','al1','ar1','S1',100),('s2','al1','ar1','S2',110),('s3','al1','ar1','S3',120),('s4','al1','ar1','S4',130);
  `);
  return sqlite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApp(sqlite: DatabaseSync, user: any, envExtra: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => { c.set("user", user); c.set("authMethod", "session"); return next(); });
  app.route("/edgesonic", cloneRoutes);
  const env = { DB: makeD1(sqlite), ...envExtra };
  return {
    async post(path: string, body: unknown) {
      return app.fetch(new Request(`http://test${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), env as any);
    },
  };
}

const grantManageUsers = (level: number) => ({ PERMISSIONS_OVERRIDE: JSON.stringify({ [String(level)]: { manage_users: true } }) });

async function main() {
  console.log("upsertStarred — plain user to own account:");
  {
    const db = buildDb();
    const alice = makeApp(db, { username: "alice", level: 1 });
    const r = await alice.post("/edgesonic/clone/upsertStarred", { items: [{ id: "s1", type: "song" }] });
    assert(r.status === 200, `200 (got ${r.status})`);
    const row = db.prepare("SELECT starred FROM annotations WHERE user_id='alice' AND item_id='s1'").get() as any;
    assert(row?.starred === 1, "alice's own star written");
  }

  console.log("\nupsertStarred — to another user needs manage_users (and level 1 is hardlocked from it):");
  {
    const db = buildDb();
    const aliceNoPerm = makeApp(db, { username: "alice", level: 1 });
    const r1 = await aliceNoPerm.post("/edgesonic/clone/upsertStarred", { userId: "bob", items: [{ id: "s1", type: "song" }] });
    assert(r1.status === 403, `403 without manage_users (got ${r1.status})`);
    const none = db.prepare("SELECT COUNT(*) AS c FROM annotations WHERE user_id='bob'").get() as any;
    assert(none.c === 0, "no star written for bob on the rejected call");

    // Level 1 (user) is hardlocked from manage_users — even an override that
    // sets it true cannot grant the capability. The new policy: dangerous
    // management perms are never available to plain users.
    const aliceGranted = makeApp(db, { username: "alice", level: 1 }, grantManageUsers(1));
    const r2 = await aliceGranted.post("/edgesonic/clone/upsertStarred", { userId: "bob", items: [{ id: "s1", type: "song" }] });
    assert(r2.status === 403, `level 1 hardlocked from manage_users even with override (got ${r2.status})`);
    const stillNone = db.prepare("SELECT COUNT(*) AS c FROM annotations WHERE user_id='bob'").get() as any;
    assert(stillNone.c === 0, "bob's star still not written under level 1 override");

    // Level 2 (admin) can receive manage_users via override and use it.
    const carolGranted = makeApp(db, { username: "carol", level: 2 }, grantManageUsers(2));
    const r3 = await carolGranted.post("/edgesonic/clone/upsertStarred", { userId: "bob", items: [{ id: "s1", type: "song" }] });
    assert(r3.status === 200, `level 2 with manage_users override 200 (got ${r3.status})`);
    const bob = db.prepare("SELECT starred FROM annotations WHERE user_id='bob' AND item_id='s1'").get() as any;
    assert(bob?.starred === 1, "bob's star written once level 2 manage_users granted");
  }

  console.log("\nupsertPlaylist — append accumulates, replace clears:");
  {
    const db = buildDb();
    const alice = makeApp(db, { username: "alice", level: 1 });
    // First chunk (replace) with s1,s2.
    let r = await alice.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p1", name: "P" }, entries: ["s1", "s2"] });
    assert(r.status === 200, `first chunk 200 (got ${r.status})`);
    // Append s3, then append s4.
    r = await alice.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p1", name: "P" }, entries: ["s3"], append: true });
    assert(r.status === 200, "append chunk 1 200");
    r = await alice.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p1", name: "P" }, entries: ["s4"], append: true });
    assert(r.status === 200, "append chunk 2 200");

    const rows = db.prepare("SELECT song_master_id, position FROM playlist_songs WHERE playlist_id='p1' ORDER BY position").all() as any[];
    assert(rows.length === 4, `4 entries after 2 appends (got ${rows.length})`);
    assert(rows.map((x) => x.song_master_id).join(",") === "s1,s2,s3,s4", "entries in order s1..s4");
    assert(rows.map((x) => x.position).join(",") === "0,1,2,3", "positions contiguous 0..3");
    const owner = db.prepare("SELECT owner, song_count, duration FROM playlists WHERE id='p1'").get() as any;
    assert(owner.owner === "alice", "owner defaulted to the session user");
    assert(owner.song_count === 4, `header song_count resynced to 4 (got ${owner.song_count})`);
    assert(owner.duration === 460, `header duration = sum (100+110+120+130=460, got ${owner.duration})`);

    // A fresh non-append call replaces the whole entry list.
    r = await alice.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p1", name: "P" }, entries: ["s2"] });
    assert(r.status === 200, "replace call 200");
    const after = db.prepare("SELECT song_master_id FROM playlist_songs WHERE playlist_id='p1'").all() as any[];
    assert(after.length === 1 && after[0].song_master_id === "s2", "replace cleared prior entries, only s2 remains");
  }

  console.log("\nupsertPlaylist — other owner needs manage_users:");
  {
    const db = buildDb();
    const aliceNoPerm = makeApp(db, { username: "alice", level: 1 });
    const r1 = await aliceNoPerm.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p9", name: "P", owner: "bob" }, entries: ["s1"] });
    assert(r1.status === 403, `403 targeting another owner without manage_users (got ${r1.status})`);

    const carol = makeApp(db, { username: "carol", level: 2 }, grantManageUsers(2));
    const r2 = await carol.post("/edgesonic/clone/upsertPlaylist", { playlist: { id: "p9", name: "P", owner: "bob" }, entries: ["s1"] });
    assert(r2.status === 200, `200 for manage_users targeting bob (got ${r2.status})`);
    const pl = db.prepare("SELECT owner FROM playlists WHERE id='p9'").get() as any;
    assert(pl?.owner === "bob", "playlist owned by bob");
  }

  console.log("\nupsertUser — super admin only:");
  {
    const db = buildDb();
    const carol = makeApp(db, { username: "carol", level: 2 }, grantManageUsers(2));
    const r1 = await carol.post("/edgesonic/clone/upsertUser", { user: { username: "newbie", password: "pw" } });
    assert(r1.status === 403, `403 for level 2 even with manage_users (got ${r1.status})`);

    const admin = makeApp(db, { username: "admin", level: 3 });
    const r2 = await admin.post("/edgesonic/clone/upsertUser", { user: { username: "newbie", password: "pw" } });
    assert(r2.status === 200, `200 for super admin (got ${r2.status})`);
    const u = db.prepare("SELECT username FROM users WHERE username='newbie'").get() as any;
    assert(!!u, "account provisioned by super admin");
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
