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

// Regression coverage for 259: artistScrapeRoutes registers all three routes
// ("/artistScrape/search", "/artistScrape/cover", "/artistScrape/bio") at the
// same depth. The bio route used to be declared as
// "/edgesonic/artistScrape/bio", which — once mounted the same way production
// does (edgesonicRoutes at "/edgesonic", artistScrapeRoutes at "/" within it)
// — resolved to the unreachable "/edgesonic/edgesonic/artistScrape/bio" and
// 404'd for every caller.
//
// Run: npx tsx test/internal/artist_scrape_routes.test.ts

import { Hono } from "hono";
import { artistScrapeRoutes } from "../../worker/src/endpoints/edgesonic/artistScrape";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

const originalFetch = globalThis.fetch;
function installFetchStub(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    return handler(url);
  }) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

function makeApp() {
  // Mirror production depth exactly: worker/src/router.ts mounts
  // edgesonicRoutes at "/edgesonic"; endpoints/edgesonic/index.ts then mounts
  // artistScrapeRoutes at "/" inside that scope. Reproducing both hops here
  // is the whole point — mounting artistScrapeRoutes directly at "/edgesonic"
  // would hide the double-prefix bug this test exists to catch.
  const edgesonicRoutes = new Hono();
  edgesonicRoutes.route("/", artistScrapeRoutes);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 1, enabled: 1, password: "x" });
    return next();
  });
  app.route("/edgesonic", edgesonicRoutes);
  return app;
}

async function main() {
  console.log("artistScrape routes resolve at the correct depth:");
  {
    installFetchStub((url) => {
      if (url.includes("search/get/web")) {
        return jsonResponse({ result: { artists: [{ id: 1, name: "Adele", picUrl: "https://p" }] } });
      }
      if (url.includes("/api/artist/desc")) {
        return jsonResponse({ briefDesc: "An English singer." });
      }
      return jsonResponse({});
    });
    const app = makeApp();

    const search = await app.request("/edgesonic/artistScrape/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease", query: "Adele" }),
    });
    assert(search.status === 200, `search: 200 (got ${search.status})`);
    const searchBody = await search.json() as { ok: boolean; artists: unknown[] };
    assert(searchBody.ok === true, "search: ok=true");

    const bio = await app.request("/edgesonic/artistScrape/bio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease", artistId: "1" }),
    });
    assert(bio.status === 200, `bio: 200, not 404 (got ${bio.status})`);
    const bioBody = await bio.json() as { ok: boolean; bio: string };
    assert(bioBody.ok === true && bioBody.bio === "An English singer.", "bio: content forwarded");

    restoreFetch();
  }

  console.log("\ndouble-prefixed bio path is NOT reachable (sanity check the fix targets the right route):");
  {
    const app = makeApp();
    const r = await app.request("/edgesonic/edgesonic/artistScrape/bio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "netease", artistId: "1" }),
    });
    assert(r.status === 404, `double-prefixed path 404s (got ${r.status})`);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nAll artist_scrape_routes tests passed.");
  }
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
