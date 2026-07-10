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

// Production bug: the Permissions page showed guest (level 0) with every
// permission ON and levels 1/2/3 with everything OFF, regardless of actual
// D1 state.
//
// Root cause: GET /permissions/list's XML puts `level` only on the parent
// wrapper (`<permissions level="X"><permission name=... enabled=.../>...
// </permissions>`), one sibling block per level. PermissionsMatrix.vue's
// load() parses with a single flat regex over the whole document
// (`/<permission\s+([^>]+)\/>/g`) that reads each matched child tag's OWN
// attribute string looking for `level="..."` — which was never there, only
// on the parent — so `parseInt(... || "0")` silently defaulted every row to
// level 0. Guest's card then matched every permission (first-match-wins
// across all mislabeled level-0 entries), and levels 1/2/3's `.find()`
// found nothing → checkboxes rendered unchecked.
//
// Fix: also stamp `level` directly on each <permission> child tag. This
// test renders the real handler's XML and runs the frontend's actual
// parsing regex against it (copied verbatim from PermissionsMatrix.vue) so
// a regression in either side breaks this test instead of silently
// round-tripping through XML string shape mismatches undetected.
//
// Run: npx tsx test/permissions_list_level_parsing.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { permissionsRoutes } from "../worker/src/endpoints/edgesonic/permissions";

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
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled) VALUES
      (3, 'manage_permissions', 1),
      (3, 'stream', 1), (2, 'stream', 1), (1, 'stream', 1), (0, 'stream', 0),
      (3, 'manage_sources', 1), (2, 'manage_sources', 1), (1, 'manage_sources', 0), (0, 'manage_sources', 0),
      (3, 'browse', 1), (2, 'browse', 1), (1, 'browse', 1), (0, 'browse', 0);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: unknown; Variables: unknown }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", permissionsRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async get(url: string) { return app.fetch(new Request(`http://test${url}`), env); },
  };
}

// Copied verbatim from web/src/components/PermissionsMatrix.vue's load().
function parseLikeFrontend(xml: string): Array<{ level: number; name: string; enabled: boolean }> {
  const items: Array<{ level: number; name: string; enabled: boolean }> = [];
  const re = /<permission\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    items.push({
      level: parseInt(m[1].match(/level="(\d)"/)?.[1] || "0"),
      name: m[1].match(/name="([^"]+)"/)?.[1] || "",
      enabled: (m[1].match(/enabled="([^"]+)"/)?.[1] || "0") === "1",
    });
  }
  return items;
}

async function main() {
  console.log("GET /edgesonic/permissions/list — frontend regex correctly attributes each row to its real level:");
  {
    const sqlite = buildDb();
    const app = makeApp(sqlite);
    const r = await app.get("/edgesonic/permissions/list");
    assert(r.status === 200, `200 (got ${r.status})`);
    const xml = await r.text();
    assert(/<permission\s[^>]*level="\d"/.test(xml), "child <permission> tags carry a level attribute in the raw XML");

    const items = parseLikeFrontend(xml);

    const find = (level: number, name: string) => items.find((p) => p.level === level && p.name === name);

    assert(find(3, "stream")?.enabled === true, "level 3 stream = true");
    assert(find(2, "stream")?.enabled === true, "level 2 stream = true");
    assert(find(1, "stream")?.enabled === true, "level 1 stream = true");
    assert(find(0, "stream")?.enabled === false, "level 0 (guest) stream = false");

    assert(find(3, "manage_sources")?.enabled === true, "level 3 manage_sources = true");
    assert(find(1, "manage_sources")?.enabled === false, "level 1 manage_sources = false");
    assert(find(0, "manage_sources")?.enabled === false, "level 0 manage_sources = false");

    // The actual bug symptom, restated as a direct assertion: guest must
    // NOT pick up every permission just because it happened to be the
    // first-parsed level.
    const guestEnabledCount = items.filter((p) => p.level === 0 && p.enabled).length;
    const guestTotal = items.filter((p) => p.level === 0).length;
    assert(guestEnabledCount < guestTotal, `guest is NOT "all enabled" (${guestEnabledCount}/${guestTotal} on)`);

    // And levels 1/2/3 must not read as universally unchecked.
    for (const lvl of [1, 2, 3]) {
      const enabledCount = items.filter((p) => p.level === lvl && p.enabled).length;
      assert(enabledCount > 0, `level ${lvl} has at least one permission parsed as enabled`);
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
