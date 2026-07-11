// 045 Internet Radio — unit tests for queries layer + permission semantics.
// Strategy: in-memory SQLite (node:sqlite) wrapped in a minimal D1 shim, then
// drive worker/src/db/queries.ts radio helpers and mirror the permissionMiddleware
// policy without spinning up Hono.
//
// Run: npx tsx test/subsonic/internet_radio.test.ts

import { DatabaseSync } from "node:sqlite";
import { createQueries } from "../../worker/src/db/queries";
import { mapInternetRadioStation } from "../../worker/src/types/subsonic";

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
    async exec(sql: string): Promise<unknown> { sqlite.exec(sql); return undefined; },
    async dump(): Promise<ArrayBuffer> { throw new Error("dump not supported"); },
    withSession(): unknown { throw new Error("sessions not supported"); },
  } as unknown as D1Database;

  return { db, sqlite };
}

// ============================================================================
// Schema setup — the parts of the production schema (migration 0018) we touch.
// ============================================================================
function setupSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      level INTEGER DEFAULT 1
    );

    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );

    CREATE TABLE internet_radio_stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      homepage_url TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (created_by) REFERENCES users(username) ON DELETE SET NULL
    );
  `);
}

function seedFixtures(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO users (username, level) VALUES
      ('alice', 1), ('bob', 2), ('root', 3), ('guest', 0);

    -- Seed manage_radio mirroring migration 0018.
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES
      (0, 'manage_radio', 0, 0),
      (1, 'manage_radio', 0, 0),
      (2, 'manage_radio', 1, 0),
      (3, 'manage_radio', 1, 0);
  `);
}

// ============================================================================
// Permission simulator — replicates permissionMiddleware("manage_radio") so we
// can verify the same allow/deny matrix without spinning up Hono.
// ============================================================================
type Caller = { username: string; level: number };

async function hasManageRadio(db: D1Database, caller: Caller): Promise<boolean> {
  const row = await db.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?"
  ).bind(caller.level, "manage_radio").first<{ enabled: number }>();
  return !!row && row.enabled === 1;
}

// ============================================================================
// Tests
// ============================================================================
async function main() {
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite);
  seedFixtures(sqlite);

  const queries = createQueries(db);

  console.log("list initially empty:");
  {
    const rows = await queries.listRadioStations();
    assert(rows.length === 0, "no stations seeded");
  }

  console.log("create → list → get:");
  {
    await queries.createRadioStation({
      id: "r-001",
      name: "Synthwave FM",
      streamUrl: "https://example.com/synth.mp3",
      homepageUrl: "https://example.com/synth",
      createdBy: "root",
    });
    await queries.createRadioStation({
      id: "r-002",
      name: "Ambient One",
      streamUrl: "https://example.com/ambient.mp3",
      // homepageUrl omitted → null
      createdBy: "bob",
    });

    const all = await queries.listRadioStations();
    assert(all.length === 2, `list returned 2 (got ${all.length})`);
    assert(all[0].name === "Ambient One", "ordered alphabetically by name (Ambient first)");
    assert(all[1].name === "Synthwave FM", "Synthwave second");

    const got = await queries.getRadioStation("r-001");
    assert(got?.name === "Synthwave FM", "fetched by id");
    assert(got?.stream_url === "https://example.com/synth.mp3", "stream_url persisted");
    assert(got?.homepage_url === "https://example.com/synth", "homepage_url persisted");
    assert(got?.created_by === "root", "created_by persisted");

    const ambient = await queries.getRadioStation("r-002");
    assert(ambient?.homepage_url === null, "homepage_url null when omitted");
  }

  console.log("mapInternetRadioStation → Subsonic shape:");
  {
    const got = await queries.getRadioStation("r-001");
    const mapped = mapInternetRadioStation(got!);
    assert(mapped.id === "r-001", "mapped id");
    assert(mapped.name === "Synthwave FM", "mapped name");
    assert(mapped.streamUrl === "https://example.com/synth.mp3", "camelCase streamUrl");
    assert(mapped.homepageUrl === "https://example.com/synth", "homepageUrl present");

    const ambient = await queries.getRadioStation("r-002");
    const mappedAmbient = mapInternetRadioStation(ambient!);
    assert(mappedAmbient.homepageUrl === undefined, "homepageUrl undefined when null (omitted from XML)");
  }

  console.log("update: rename only:");
  {
    // Force at least 1 second between insert and update so updated_at differs reliably.
    sqlite.exec("UPDATE internet_radio_stations SET updated_at = updated_at - 5 WHERE id = 'r-001'");
    const before = await queries.getRadioStation("r-001");

    const changes = await queries.updateRadioStation("r-001", { name: "Synthwave 80s" });
    assert(changes === 1, "1 row changed on rename");

    const after = await queries.getRadioStation("r-001");
    assert(after?.name === "Synthwave 80s", "name updated");
    assert(after?.stream_url === "https://example.com/synth.mp3", "stream_url untouched");
    assert(after?.homepage_url === "https://example.com/synth", "homepage_url untouched");
    assert((after?.updated_at ?? 0) > (before?.updated_at ?? 0), "updated_at bumped");
  }

  console.log("update: stream_url only:");
  {
    const changes = await queries.updateRadioStation("r-001", { streamUrl: "https://example.com/v2.mp3" });
    assert(changes === 1, "1 row changed");
    const r = await queries.getRadioStation("r-001");
    assert(r?.stream_url === "https://example.com/v2.mp3", "stream_url updated");
    assert(r?.name === "Synthwave 80s", "name untouched");
  }

  console.log("update: homepage_url cleared (empty string → null):");
  {
    const changes = await queries.updateRadioStation("r-001", { homepageUrl: null });
    assert(changes === 1, "1 row changed on clear");
    const r = await queries.getRadioStation("r-001");
    assert(r?.homepage_url === null, "homepage_url cleared to null");
  }

  console.log("update: set homepage on a station that had none:");
  {
    const changes = await queries.updateRadioStation("r-002", { homepageUrl: "https://example.com/ambient-new" });
    assert(changes === 1, "1 row changed");
    const r = await queries.getRadioStation("r-002");
    assert(r?.homepage_url === "https://example.com/ambient-new", "homepage_url set on r-002");
  }

  console.log("update: empty patch is a 0-changes no-op (endpoint should 400):");
  {
    const changes = await queries.updateRadioStation("r-001", {});
    assert(changes === 0, "empty patch → 0 changes (helper returns early)");
  }

  console.log("update: unknown id → 0 changes:");
  {
    const changes = await queries.updateRadioStation("r-does-not-exist", { name: "ghost" });
    assert(changes === 0, "unknown id → 0 changes (endpoint should 404)");
  }

  console.log("permission gate (mirrors permissionMiddleware('manage_radio')):");
  {
    const guest: Caller = { username: "guest", level: 0 };
    const alice: Caller = { username: "alice", level: 1 };
    const bob: Caller = { username: "bob", level: 2 };
    const root: Caller = { username: "root", level: 3 };

    assert(!(await hasManageRadio(db, guest)), "level=0 (guest) DENIED");
    assert(!(await hasManageRadio(db, alice)), "level=1 (user) DENIED");
    assert(await hasManageRadio(db, bob), "level=2 (admin) ALLOWED");
    assert(await hasManageRadio(db, root), "level=3 (super admin) ALLOWED");
  }

  console.log("delete: existing id → 1 change; gone afterwards:");
  {
    const changes = await queries.deleteRadioStation("r-001");
    assert(changes === 1, "1 row deleted");
    const gone = await queries.getRadioStation("r-001");
    assert(gone === null, "station no longer fetchable");
    const remaining = await queries.listRadioStations();
    assert(remaining.length === 1, "1 station remaining");
    assert(remaining[0].id === "r-002", "r-002 survived");
  }

  console.log("delete: unknown id → 0 changes (endpoint should 404):");
  {
    const changes = await queries.deleteRadioStation("r-does-not-exist");
    assert(changes === 0, "0 changes when id missing");
  }

  console.log("created_by FK ON DELETE SET NULL:");
  {
    // Bob created r-002; deleting bob should null out created_by, not the row.
    sqlite.exec("DELETE FROM users WHERE username = 'bob'");
    const r = await queries.getRadioStation("r-002");
    assert(r !== null, "station survives author deletion");
    assert(r?.created_by === null, "created_by SET NULL when author deleted");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
