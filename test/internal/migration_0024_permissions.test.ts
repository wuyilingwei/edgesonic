// now folded into Schema.sql §5) seeds the 5 new permission rows × 4 levels
// (20 rows total) with the documented default matrix (L3=1, L2/L1/L0=0).
//
// Coverage:
//  1. Apply Schema.sql → all 5 new permissions present at all 4 levels (20 rows)
//  2. Default values match the matrix: super-admin enabled, all others off
//  3. INSERT OR IGNORE is idempotent — re-running Schema.sql does not clobber
//    changes a admin made via the Permissions UI (we simulate by flipping
//    one row then re-applying)
//
// Note: dispatch_work is checked too but it's seeded by the 0021 block (052a).
// Schema.sql does NOT re-seed it inside the 0024 block — we only assert the 5
// new keys.
//
// Run: npx tsx test/internal/migration_0024_permissions.test.ts

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const NEW_PERMS = [
  "manage_cloudflare",
  "maintenance_cleanup",
  "maintenance_reclaim",
  "maintenance_reset",
  "view_all_users_items",
] as const;

function buildSchema(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  // The full production schema is the single source of truth. We only need
  // user_permissions here, but running the whole file mirrors what a fresh
  // D1 database sees on first deploy.
  const schemaSql = readFileSync(
    resolve(__dirname, "../../worker/migrations/Schema.sql"),
    "utf-8",
  );
  sqlite.exec(schemaSql);
  return sqlite;
}

function applySchema(sqlite: DatabaseSync) {
  const schemaSql = readFileSync(
    resolve(__dirname, "../../worker/migrations/Schema.sql"),
    "utf-8",
  );
  sqlite.exec(schemaSql);
}

function getEnabled(sqlite: DatabaseSync, level: number, permission: string): number | null {
  const row = sqlite.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?",
  ).get(level, permission) as { enabled: number } | undefined;
  return row?.enabled ?? null;
}

async function main() {
  console.log("Apply Schema.sql from disk → all new permissions land at all 4 levels:");
  {
    const sqlite = buildSchema();
    for (const perm of NEW_PERMS) {
      for (const level of [0, 1, 2, 3]) {
        const row = sqlite.prepare(
          "SELECT enabled FROM user_permissions WHERE level = ? AND permission = ?",
        ).get(level, perm);
        assert(row !== undefined, `row exists: level=${level} permission=${perm}`);
      }
    }
  }

  console.log("\nDefault matrix: L3=1 for every new permission:");
  {
    const sqlite = buildSchema();
    for (const perm of NEW_PERMS) {
      assert(getEnabled(sqlite, 3, perm) === 1,
        `L3 ${perm} → enabled=1 (got ${getEnabled(sqlite, 3, perm)})`);
    }
  }

  console.log("\nDefault matrix: L2/L1/L0 all disabled by default:");
  {
    const sqlite = buildSchema();
    for (const perm of NEW_PERMS) {
      for (const level of [0, 1, 2]) {
        assert(getEnabled(sqlite, level, perm) === 0,
          `L${level} ${perm} → enabled=0 (got ${getEnabled(sqlite, level, perm)})`);
      }
    }
  }

  console.log("\nINSERT OR IGNORE is idempotent — preserves admin overrides on re-run:");
  {
    const sqlite = buildSchema();
    // Operator flips manage_cloudflare on for L2 via the Permissions UI.
    sqlite.prepare(
      "UPDATE user_permissions SET enabled = 1 WHERE level = 2 AND permission = 'manage_cloudflare'",
    ).run();
    assert(getEnabled(sqlite, 2, "manage_cloudflare") === 1, "operator override applied");
    // Re-apply Schema.sql — INSERT OR IGNORE should NOT overwrite the flipped row.
    applySchema(sqlite);
    assert(getEnabled(sqlite, 2, "manage_cloudflare") === 1,
      `operator override survives re-run (got ${getEnabled(sqlite, 2, "manage_cloudflare")})`);
    // Other unchanged rows still at their defaults.
    assert(getEnabled(sqlite, 3, "manage_cloudflare") === 1, "L3 still enabled");
    assert(getEnabled(sqlite, 1, "manage_cloudflare") === 0, "L1 still disabled");
  }

  console.log("\nRow counts: 5 new permissions × 4 levels = 20 rows from the 0024 block:");
  {
    const sqlite = buildSchema();
    const row = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM user_permissions WHERE permission IN (?, ?, ?, ?, ?)",
    ).get(...NEW_PERMS) as { n: number };
    assert(row.n === 20, `total rows = 20 (got ${row.n})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
