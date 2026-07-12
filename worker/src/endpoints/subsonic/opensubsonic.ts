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
// Routes:
//  - GET/POST /rest/getOpenSubsonicExtensions (no auth — declared in auth.ts NO_AUTH_PATHS)
//   - GET/POST /rest/tokenInfo                (any auth → echoes current user)
//
// Each is also exposed at `.view` so native Subsonic clients (Symfonium, DSub,
// Navidrome web, etc.) hit them. POST registrations satisfy our self-declared
// `formPost` extension.
//
// We ONLY advertise extensions EdgeSonic actually implements:
//  * apiKeyAuthentication v1 — auth.ts resolves `?apiKey=...` via the D1
//   `api_keys` table (api_key is the primary key, so it alone identifies
//   the account); `u` is optional when apiKey is present, matching spec.
//   * tokenInfo v1          — this file
//   * formPost v1           — all mutating Subsonic endpoints accept POST
//   * songLyrics v1         — 108: getLyricsBySongId emits spec-shaped
//   structuredLyrics ({start,value} lines); clients only call it when the
//   extension is advertised, which is why lyrics never showed in players.
//   * edgeSonicCloneProxy v1 — EdgeSonic-specific clone/proxy capability plus
//   automatic exact/fuzzy remote-id → local-id merge support.
//
// NOT advertised (kept honest):
//  * transcodeOffset — 036
//  * indexBasedQueue — no client implementation yet

import { Hono } from "hono";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const openSubsonicRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// ---------------------------------------------------------------------------
// getOpenSubsonicExtensions
// ---------------------------------------------------------------------------
// Spec (107): one `<openSubsonicExtensions name="...">` element per
// extension, each carrying `<versions>N</versions>` CHILD ELEMENTS — the
// shape Navidrome emits. The JSON serialization (middleware/format.ts) turns
// this into `"openSubsonicExtensions":[{"name":"...","versions":[1,2]}]`
// with versions as an array of numbers, exactly as the OpenSubsonic docs
// require. The old form (versions="[1]" attribute) serialized to the JSON
// string `"versions":"[1]"`, which strict clients reject.

const EXTENSIONS: Array<{ name: string; versions: number[]; attrs?: Record<string, string> }> = [
  { name: "apiKeyAuthentication", versions: [1] },
  { name: "tokenInfo", versions: [1] },
  { name: "formPost", versions: [1] },
  { name: "songLyrics", versions: [1] },
  {
    name: "edgeSonicCloneProxy",
    versions: [1],
    attrs: { proxy: "true", autoMerge: "true", fuzzyMerge: "true" },
  },
];

const extensionsHandler = (c: import("hono").Context) => {
  return c.text(
    subsonicOK({
      openSubsonicExtensions: EXTENSIONS.map((ext) => ({
        _attributes: { name: ext.name, ...(ext.attrs || {}) },
        versions: ext.versions,
      })),
    }),
    200, XML,
  );
};

openSubsonicRoutes.get("/getOpenSubsonicExtensions", extensionsHandler);
openSubsonicRoutes.get("/getOpenSubsonicExtensions.view", extensionsHandler);
openSubsonicRoutes.post("/getOpenSubsonicExtensions", extensionsHandler);
openSubsonicRoutes.post("/getOpenSubsonicExtensions.view", extensionsHandler);

// ---------------------------------------------------------------------------
// tokenInfo
// ---------------------------------------------------------------------------
// Spec (extension): returns the authenticated user's basic info.
// Reference servers emit only `<tokenInfo username="..."/>`; we additionally
// include level + enabled permission names so the Web client can short-circuit
// permission-aware UI without a follow-up call.

const tokenInfoHandler = async (c: import("hono").Context) => {
  const user = c.get("user") as User;

  // Pull enabled permissions for this user's level (1 row per permission).
  const db = (c.env as Env).DB;
  const rows = await db
    .prepare(
      "SELECT permission FROM user_permissions WHERE level = ? AND enabled = 1 ORDER BY permission ASC"
    )
    .bind(user.level)
    .all<{ permission: string }>();
  const perms = rows.results.map((r) => r.permission);

  return c.text(
    subsonicOK({
      tokenInfo: {
        _attributes: {
          username: user.username,
          // OpenSubsonic spec stops at username. EdgeSonic enriches:
          level: String(user.level),
        },
        permission: perms.map((name) => ({ _attributes: { name } })),
      },
    }),
    200, XML,
  );
};

openSubsonicRoutes.get("/tokenInfo", tokenInfoHandler);
openSubsonicRoutes.get("/tokenInfo.view", tokenInfoHandler);
openSubsonicRoutes.post("/tokenInfo", tokenInfoHandler);
openSubsonicRoutes.post("/tokenInfo.view", tokenInfoHandler);
