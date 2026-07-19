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

//
// Coverage:
//  1. Explicit EDGESONIC_VERSION / EDGESONIC_BUILD_TIME override the asset.
//  2. When env vars are absent, the deployed build-info.json asset is used.
//  3. An unavailable asset falls back safely to dev/null.
//  4. NO_AUTH_PATHS contains '/edgesonic/version' so unauthenticated callers
//    reach the handler (sanity-check the auth allowlist wiring).
//
// We mount versionRoutes directly under the same `/edgesonic` prefix the
// production router uses (worker/src/endpoints/edgesonic/index.ts), no other
// middleware. The auth check is asserted by importing NO_AUTH_PATHS' source
// of truth and checking membership — this keeps the test honest if someone
// later removes the entry from auth.ts.
//
// Run: npx tsx test/internal/version_endpoint.test.ts

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { versionRoutes } from "../../worker/src/endpoints/edgesonic/version";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ${"✓"} ${msg}`);
  else {
    failures++;
    console.error(`  ${"✗"} ${msg}`);
  }
}

interface VersionResponse {
  ok?: boolean;
  version?: string;
  buildTime?: string | null;
}

function makeApp(env: {
  EDGESONIC_VERSION?: string;
  EDGESONIC_BUILD_TIME?: string;
  asset?: { version: string; buildTime: string | null } | null;
}) {
  const app = new Hono();
  // Mirror production: edgesonicRoutes is mounted at /edgesonic in router.ts,
  // and versionRoutes is registered at "/version" inside that scope.
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = {
      ...env,
      ASSETS: {
        fetch: async () => env.asset
          ? new Response(JSON.stringify(env.asset), { headers: { "Content-Type": "application/json" } })
          : new Response("Not found", { status: 404 }),
      },
    };
    await next();
  });
  app.route("/edgesonic", versionRoutes);
  return app;
}

async function run() {
  // -------------------------------------------------------------------------
  // 1. Explicit environment override
  // -------------------------------------------------------------------------
  console.log("explicit environment override:");
  {
    const app = makeApp({
      EDGESONIC_VERSION: "42",
      EDGESONIC_BUILD_TIME: "2026-07-18T18:00:00.000Z",
      asset: { version: "asset", buildTime: "2026-07-18T17:00:00.000Z" },
    });
    const r = await app.request("/edgesonic/version");
    assert(r.status === 200, "200 OK");
    const j = (await r.json()) as VersionResponse;
    assert(j.ok === true, "ok=true");
    assert(j.version === "42", "version uses env override");
    assert(j.buildTime === "2026-07-18T18:00:00.000Z", "buildTime uses env override");
  }

  // -------------------------------------------------------------------------
  // 2. Asset fallback when deployment vars are absent
  // -------------------------------------------------------------------------
  console.log("\nbuild-info.json asset fallback:");
  {
    const app = makeApp({ asset: { version: "asset-build", buildTime: "2026-07-18T18:01:00.000Z" } });
    const r = await app.request("/edgesonic/version");
    assert(r.status === 200, "200 OK");
    const j = (await r.json()) as VersionResponse;
    assert(j.ok === true, "ok=true");
    assert(j.version === "asset-build", "version uses bundled build-info.json");
    assert(j.buildTime === "2026-07-18T18:01:00.000Z", "buildTime uses bundled build-info.json");
  }

  // -------------------------------------------------------------------------
  // 3. Missing asset is safe
  // -------------------------------------------------------------------------
  console.log("\nasset unavailable:");
  {
    const app = makeApp({ asset: null });
    const j = (await (await app.request("/edgesonic/version")).json()) as VersionResponse;
    assert(j.version === "dev", 'version falls back to "dev"');
    assert(j.buildTime === null, "buildTime falls back to null");
  }

  // -------------------------------------------------------------------------
  // 4. NO_AUTH_PATHS contains /edgesonic/version — verify by reading auth.ts
  //  source. We avoid importing the full auth module (which drags in
  //  Cloudflare-only types) and just grep its source text instead.
  // -------------------------------------------------------------------------
  console.log("\nauth.ts allowlist:");
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const authSrc = readFileSync(
      resolve(here, "../../worker/src/auth.ts"),
      "utf-8",
    );
    const noAuthBlockMatch = authSrc.match(/const NO_AUTH_PATHS = new Set\(\[([\s\S]*?)\]\);/);
    assert(noAuthBlockMatch !== null, "NO_AUTH_PATHS block found in auth.ts");
    const block = noAuthBlockMatch ? noAuthBlockMatch[1] : "";
    assert(
      block.includes('"/edgesonic/version"'),
      '"/edgesonic/version" present in NO_AUTH_PATHS',
    );
  }

  // -------------------------------------------------------------------------
  // 5. Content-Type is JSON
  // -------------------------------------------------------------------------
  console.log("\ncontent-type:");
  {
    const app = makeApp({ asset: { version: "asset-build", buildTime: null } });
    const r = await app.request("/edgesonic/version");
    const ct = r.headers.get("content-type") || "";
    assert(ct.includes("application/json"), "Content-Type is application/json");
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nAll version_endpoint tests passed.");
  }
}

run().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
