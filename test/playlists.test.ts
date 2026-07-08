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

// 034 Playlists CRUD — unit tests for queries layer + permission semantics.
// Strategy: in-memory SQLite (node:sqlite) wrapped in a minimal D1 shim, then
// drive worker/src/db/queries.ts and the playlist endpoint permission rules
// directly. Avoids Workers runtime; covers the parts that have real bugs.
//
// Run: npx tsx test/playlists.test.ts

import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../worker/src/db/queries";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ============================================================================
// D1 shim — implements the subset of D1Database used by queries.ts.
// ============================================================================
function makeD1Shim(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...args: unknown[]): D1PreparedStatement {
        binds = args;
        return stmt;
      },
      async first<T = unknown>(): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = s.get(...(binds as never[]));
        return (row ?? null) as T | null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return { results: rows as T[] };
      },
      async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
        const s = sqlite.prepare(sql);
        const info = s.run(...(binds as never[]));
        return { meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
      async raw<T = unknown>(): Promise<T[]> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return rows as T[];
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  }

  const db = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
      // node:sqlite has no first-class transaction API; execute serially.
      // In production D1 wraps batch in a transaction; for tests serial is enough
      // because we control failure surface.
      sqlite.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of statements) {
          out.push(await (s as unknown as { run(): Promise<unknown> }).run());
        }
        sqlite.exec("COMMIT");
        return out as T[];
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string): Promise<unknown> {
      sqlite.exec(sql);
      return undefined;
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error("dump not supported");
    },
    withSession(): unknown { throw new Error("sessions not supported"); },
  } as unknown as D1Database;

  return { db, sqlite };
}

// ============================================================================
// Schema setup — minimum tables touched by the playlist queries.
// ============================================================================
function setupSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      level INTEGER DEFAULT 1
    );

    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT, sort_name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT,
      album_artist_id TEXT,
      title TEXT,
      sort_title TEXT,
      track INTEGER,
      disc INTEGER,
      duration INTEGER,
      genre TEXT,
      compilation INTEGER DEFAULT 0,
      participants TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      public INTEGER DEFAULT 0,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      cover_r2_key TEXT,
      comment TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX idx_playlists_owner_public ON playlists(owner, public);

    CREATE TABLE playlist_songs (
      playlist_id TEXT NOT NULL,
      song_master_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (playlist_id, position),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
    );
  `);
}

function seedFixtures(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO users (username, level) VALUES ('alice', 1), ('bob', 1), ('root', 3);
    INSERT INTO albums (id, name) VALUES ('al-a1', 'Album One');
    INSERT INTO song_masters (id, album_id, title, duration) VALUES
      ('s1', 'al-a1', 'One', 100),
      ('s2', 'al-a1', 'Two', 200),
      ('s3', 'al-a1', 'Three', 300),
      ('s4', 'al-a1', 'Four', 400);
  `);
}

// ============================================================================
// Endpoint-style permission simulator — mirrors the policy in playlists.ts
// without spinning up the whole Hono router.
// ============================================================================
type Caller = { username: string; level: number };

async function canModify(db: D1Database, caller: Caller, playlistId: string): Promise<boolean> {
  const q = createQueries(db);
  const p = await q.getPlaylistById(playlistId);
  if (!p) return false;
  return p.owner === caller.username || caller.level === 3;
}

// Mirror getPlaylistsHandler's filter: list playlists owned-by-self or public.
async function listVisible(db: D1Database, caller: Caller): Promise<string[]> {
  const q = createQueries(db);
  const rows = await q.getPlaylistsForUser(caller.username);
  return rows.map((r) => r.id);
}

// ============================================================================
// Tests
// ============================================================================
async function main() {
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite);
  seedFixtures(sqlite);

  const queries = createQueries(db);

  console.log("create with songs → get → assert:");
  {
    await queries.createPlaylist({
      id: "pl-alice-1",
      name: "Alice's Mix",
      owner: "alice",
      isPublic: false,
      songIds: ["s1", "s2", "s3"],
    });

    const p = await queries.getPlaylistById("pl-alice-1");
    assert(p?.name === "Alice's Mix", "name persisted");
    assert(p?.owner === "alice", "owner=alice");
    assert(p?.public === 0, "private by default");
    assert(p?.song_count === 3, `song_count=3 (got ${p?.song_count})`);
    assert(p?.duration === 600, `duration=600 (got ${p?.duration})`);

    const songs = await queries.getPlaylistSongs("pl-alice-1");
    assert(songs.length === 3, "3 entries");
    assert(songs.map((s) => s.id).join(",") === "s1,s2,s3", "ordered s1,s2,s3");
  }

  console.log("update: rename + add + remove:");
  {
    await queries.updatePlaylistMeta("pl-alice-1", { name: "Alice's Better Mix", comment: "best of" });
    await queries.addSongsToPlaylist("pl-alice-1", ["s4"]);
    let songs = await queries.getPlaylistSongs("pl-alice-1");
    assert(songs.map((s) => s.id).join(",") === "s1,s2,s3,s4", "appended s4 at tail");

    // Remove index 1 (=s2) and index 2 (=s3 in original) — Subsonic uses
    // indices into the current ordering.
    await queries.removeSongsFromPlaylist("pl-alice-1", [1, 2]);
    songs = await queries.getPlaylistSongs("pl-alice-1");
    assert(songs.map((s) => s.id).join(",") === "s1,s4", `kept s1,s4 (got ${songs.map((s) => s.id).join(",")})`);

    const p = await queries.getPlaylistById("pl-alice-1");
    assert(p?.name === "Alice's Better Mix", "rename took effect");
    assert(p?.comment === "best of", "comment persisted");
    assert(p?.song_count === 2, `recalc song_count=2 (got ${p?.song_count})`);
    assert(p?.duration === 500, `recalc duration=500 (got ${p?.duration})`);
  }

  console.log("delete: non-owner non-admin denied; admin permitted:");
  {
    // Bob shouldn't be able to modify/delete Alice's playlist
    const bob: Caller = { username: "bob", level: 1 };
    const bobCan = await canModify(db, bob, "pl-alice-1");
    assert(!bobCan, "bob (level=1) cannot modify alice's playlist");

    // Admin (level 3) can
    const admin: Caller = { username: "root", level: 3 };
    const adminCan = await canModify(db, admin, "pl-alice-1");
    assert(adminCan, "admin (level=3) can modify any playlist");

    await queries.deletePlaylist("pl-alice-1");
    const gone = await queries.getPlaylistById("pl-alice-1");
    assert(gone === null, "playlist removed");

    // Cascade: playlist_songs gone too
    const orphans = sqlite.prepare("SELECT COUNT(*) AS c FROM playlist_songs WHERE playlist_id = ?").get("pl-alice-1") as { c: number };
    assert(orphans.c === 0, "playlist_songs cascade-deleted");
  }

  console.log("getPlaylists: alice doesn't see bob's private list:");
  {
    await queries.createPlaylist({ id: "pl-bob-priv", name: "Bob Private", owner: "bob", isPublic: false, songIds: ["s1"] });
    await queries.createPlaylist({ id: "pl-bob-pub", name: "Bob Public", owner: "bob", isPublic: true, songIds: ["s2"] });
    await queries.createPlaylist({ id: "pl-alice-2", name: "Alice Two", owner: "alice", isPublic: false, songIds: [] });

    const aliceSees = await listVisible(db, { username: "alice", level: 1 });
    assert(aliceSees.includes("pl-alice-2"), "alice sees her own private list");
    assert(aliceSees.includes("pl-bob-pub"), "alice sees bob's public list");
    assert(!aliceSees.includes("pl-bob-priv"), "alice does NOT see bob's private list");

    const bobSees = await listVisible(db, { username: "bob", level: 1 });
    assert(bobSees.includes("pl-bob-priv"), "bob sees his private list");
    assert(bobSees.includes("pl-bob-pub"), "bob sees his public list");
    assert(!bobSees.includes("pl-alice-2"), "bob does not see alice's private list");
  }

  console.log("replacePlaylistSongs: clear + reinsert recomputes totals:");
  {
    await queries.replacePlaylistSongs("pl-bob-pub", ["s3", "s4"]);
    const p = await queries.getPlaylistById("pl-bob-pub");
    assert(p?.song_count === 2, "song_count recomputed to 2");
    assert(p?.duration === 700, `duration recomputed to 700 (got ${p?.duration})`);
    const songs = await queries.getPlaylistSongs("pl-bob-pub");
    assert(songs.map((s) => s.id).join(",") === "s3,s4", "songs replaced in order");
  }

  console.log("removeSongsFromPlaylist on empty indices is a no-op:");
  {
    const before = await queries.getPlaylistSongs("pl-bob-pub");
    await queries.removeSongsFromPlaylist("pl-bob-pub", []);
    const after = await queries.getPlaylistSongs("pl-bob-pub");
    assert(before.length === after.length, "no-op removal preserves entries");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
