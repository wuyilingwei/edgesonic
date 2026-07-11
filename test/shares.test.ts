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

// 044 Sharing — unit tests for queries layer + permission semantics + public
// /share/:id behaviour (existence / expiry / view counting).
//
// Strategy: in-memory SQLite (node:sqlite) wrapped in a minimal D1 shim — the
// same recipe used by test/playlists.test.ts. We drive db/queries.ts directly
// for CRUD and exercise the public-route policy via a small simulator so we
// don't need to spin up the full Hono router (storage adapters etc.).
//
// Run: npx tsx test/shares.test.ts

import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../worker/src/db/queries";
import { mapShare, mapShareDetail } from "../worker/src/types/subsonic";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ============================================================================
// D1 shim (lifted verbatim from test/playlists.test.ts — same SQLite backing,
// same execution model). Kept inline so each test file is self-contained.
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
    async dump(): Promise<ArrayBuffer> { throw new Error("dump not supported"); },
    withSession(): unknown { throw new Error("sessions not supported"); },
  } as unknown as D1Database;

  return { db, sqlite };
}

// ============================================================================
// Schema setup — minimum tables touched by share queries.
// ============================================================================
function setupSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      level INTEGER DEFAULT 1
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT);
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
      lyrics TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE shares (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      description TEXT,
      expires_at INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_visited_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX idx_shares_user ON shares(user_id);

    CREATE TABLE share_entries (
      share_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      song_master_id TEXT NOT NULL,
      PRIMARY KEY (share_id, position),
      FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
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
      ('s3', 'al-a1', 'Three', 300);
  `);
}

// ============================================================================
// Endpoint policy simulator — mirrors the visibility / mutate guards in
// shares.ts without spinning up Hono. Keeps the test focused on the actual
// policy decision points.
// ============================================================================
type Caller = { username: string; level: number };

async function canModify(db: D1Database, caller: Caller, shareId: string): Promise<boolean> {
  const q = createQueries(db);
  const s = await q.getShareById(shareId);
  if (!s) return false;
  return s.user_id === caller.username || caller.level === 3;
}

// Mirrors getSharesHandler: admin (level=3) sees every share; everyone else
// sees only their own.
async function listVisible(db: D1Database, caller: Caller): Promise<string[]> {
  const q = createQueries(db);
  const rows = await q.getSharesForUser(caller.username, caller.level === 3);
  return rows.map((r) => r.id);
}

// Mirrors the policy of GET /share/:id (not the byte stream itself — that's
// adapter integration). Returns:
//   "ok"      — share visitable, view_count incremented
//  "not-found" — share id unknown
//   "expired" — expires_at < now
async function publicAccess(db: D1Database, shareId: string, now: number): Promise<"ok" | "not-found" | "expired" | "no-entries"> {
  const q = createQueries(db);
  const s = await q.getShareById(shareId);
  if (!s) return "not-found";
  if (s.expires_at !== null && s.expires_at < now) return "expired";
  const entries = await q.getShareEntries(shareId);
  if (entries.length === 0) return "no-entries";
  await q.incrementShareView(shareId);
  return "ok";
}

// ============================================================================
// Tests
// ============================================================================
async function main() {
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite);
  seedFixtures(sqlite);

  const queries = createQueries(db);

  console.log("create share with single song → get → assert:");
  {
    await queries.createShare({
      id: "sh-alice-1",
      userId: "alice",
      description: "for friend",
      expiresAt: null,
      songIds: ["s1"],
    });

    const s = await queries.getShareById("sh-alice-1");
    assert(s !== null, "share row created");
    assert(s?.user_id === "alice", "owner=alice");
    assert(s?.description === "for friend", "description persisted");
    assert(s?.expires_at === null, "expires_at=null (never expires)");
    assert(s?.view_count === 0, "view_count starts at 0");

    const entries = await queries.getShareEntries("sh-alice-1");
    assert(entries.length === 1 && entries[0].id === "s1", "entry list = [s1]");
  }

  console.log("create share with multiple songs preserves order:");
  {
    await queries.createShare({
      id: "sh-alice-2",
      userId: "alice",
      description: null,
      expiresAt: null,
      songIds: ["s3", "s1", "s2"],
    });
    const entries = await queries.getShareEntries("sh-alice-2");
    assert(entries.map((e) => e.id).join(",") === "s3,s1,s2", "entries kept input order");
  }

  console.log("create share with future expires_at:");
  {
    const future = Math.floor(Date.now() / 1000) + 3600;
    await queries.createShare({
      id: "sh-alice-3",
      userId: "alice",
      description: null,
      expiresAt: future,
      songIds: ["s2"],
    });
    const s = await queries.getShareById("sh-alice-3");
    assert(s?.expires_at === future, `expires_at=${future} (got ${s?.expires_at})`);
  }

  console.log("updateShareMeta: patch description / clear description / patch expires:");
  {
    await queries.updateShareMeta("sh-alice-1", { description: "updated" });
    let s = await queries.getShareById("sh-alice-1");
    assert(s?.description === "updated", "description updated");

    await queries.updateShareMeta("sh-alice-1", { description: null });
    s = await queries.getShareById("sh-alice-1");
    assert(s?.description === null, "description cleared via null");

    const newExpiry = Math.floor(Date.now() / 1000) + 7200;
    await queries.updateShareMeta("sh-alice-1", { expiresAt: newExpiry });
    s = await queries.getShareById("sh-alice-1");
    assert(s?.expires_at === newExpiry, "expires_at updated");

    await queries.updateShareMeta("sh-alice-1", { expiresAt: null });
    s = await queries.getShareById("sh-alice-1");
    assert(s?.expires_at === null, "expires_at cleared via null");
  }

  console.log("permission: non-owner non-admin cannot modify; admin can:");
  {
    const bob: Caller = { username: "bob", level: 1 };
    const bobCan = await canModify(db, bob, "sh-alice-1");
    assert(!bobCan, "bob (level=1) cannot modify alice's share");

    const admin: Caller = { username: "root", level: 3 };
    const adminCan = await canModify(db, admin, "sh-alice-1");
    assert(adminCan, "admin (level=3) can modify any share");
  }

  console.log("getShares scope: admin sees all; users see only their own:");
  {
    await queries.createShare({
      id: "sh-bob-1",
      userId: "bob",
      description: null,
      expiresAt: null,
      songIds: ["s3"],
    });

    const aliceSees = await listVisible(db, { username: "alice", level: 1 });
    assert(aliceSees.includes("sh-alice-1") && aliceSees.includes("sh-alice-2") && aliceSees.includes("sh-alice-3"), "alice sees her three shares");
    assert(!aliceSees.includes("sh-bob-1"), "alice does NOT see bob's share");

    const bobSees = await listVisible(db, { username: "bob", level: 1 });
    assert(bobSees.includes("sh-bob-1"), "bob sees his share");
    assert(!bobSees.includes("sh-alice-1"), "bob does NOT see alice's share");

    const adminSees = await listVisible(db, { username: "root", level: 3 });
    assert(adminSees.includes("sh-alice-1") && adminSees.includes("sh-bob-1"), "admin sees both alice's and bob's shares");
  }

  console.log("public /share/:id semantics: not-found / expired / ok increments view_count:");
  {
    const now = Math.floor(Date.now() / 1000);

    const missing = await publicAccess(db, "sh-does-not-exist", now);
    assert(missing === "not-found", "unknown id → not-found");

    // Create an expired share by hand (constructor seconds clock)
    await queries.createShare({
      id: "sh-expired",
      userId: "alice",
      description: null,
      expiresAt: now - 1,
      songIds: ["s1"],
    });
    const expired = await publicAccess(db, "sh-expired", now);
    assert(expired === "expired", "past expires_at → expired");

    // sh-alice-2 has no expiry; first hit increments view_count
    const before = await queries.getShareById("sh-alice-2");
    assert(before?.view_count === 0, "view_count=0 before hit");
    const ok = await publicAccess(db, "sh-alice-2", now);
    assert(ok === "ok", "valid share → ok");
    const after = await queries.getShareById("sh-alice-2");
    assert(after?.view_count === 1, `view_count=1 after one hit (got ${after?.view_count})`);
    assert(after?.last_visited_at !== null, "last_visited_at populated after hit");

    // Second hit increments again
    await publicAccess(db, "sh-alice-2", now);
    const twice = await queries.getShareById("sh-alice-2");
    assert(twice?.view_count === 2, `view_count=2 after two hits (got ${twice?.view_count})`);
  }

  console.log("mapShare / mapShareDetail produce expected attribute set:");
  {
    const s = await queries.getShareById("sh-alice-2");
    if (!s) throw new Error("fixture missing");
    const songs = await queries.getShareEntries("sh-alice-2");
    const detail = mapShareDetail(s, `https://edge.example/share/${s.id}`, songs);
    assert(detail.attrs.id === "sh-alice-2", "share attrs.id");
    assert(detail.attrs.url === "https://edge.example/share/sh-alice-2", "share attrs.url is absolute");
    assert(detail.attrs.username === "alice", "share attrs.username=owner");
    assert(detail.attrs.expires === undefined, "no expires → attribute omitted");
    assert(detail.attrs.visitCount === 2, "visitCount reflects view_count");
    assert(detail.entries.length === 3, "three entries mapped");
    assert(detail.entries[0].id === "s3", "first entry preserves stored order");

    // Standalone mapShare with description sanity
    const s1 = await queries.getShareById("sh-alice-3");
    if (!s1) throw new Error("fixture missing");
    const m = mapShare(s1, "https://edge.example/share/sh-alice-3");
    assert(typeof m.expires === "string" && m.expires.endsWith("Z"), "expires is ISO 8601 string when set");
  }

  console.log("delete share cascades share_entries:");
  {
    await queries.deleteShare("sh-alice-2");
    const gone = await queries.getShareById("sh-alice-2");
    assert(gone === null, "share row deleted");
    const orphans = sqlite.prepare("SELECT COUNT(*) AS c FROM share_entries WHERE share_id = ?").get("sh-alice-2") as { c: number };
    assert(orphans.c === 0, "share_entries cascade-deleted");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
