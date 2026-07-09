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

import { Hono } from "hono";
import { getFeatureString } from "../../utils/features";
import type { AuthMethod } from "../../auth";
import type { User } from "../../types/entities";

export const statsRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User; authMethod: AuthMethod };
}>();

// GET /edgesonic/stats/storage
// Returns a storage breakdown (song count + bytes) grouped by storage type,
// plus R2 cover art count and the user-configured free-tier allocation for
// cost estimation. Super-admin only (billing data).
statsRoutes.get("/stats/storage", async (c) => {
  const user = c.get("user");
  if (user.level < 3) return c.json({ ok: false, error: "Not authorized" }, 403);

  const db = c.env.DB;

  // 109 — exclude missing=1 rows. hotCacheWebdav (103) claims a row (storage_uri
  // already r2://..., size copied from the WebDAV source as a placeholder) BEFORE
  // the R2 put succeeds, then flips missing=0 + writes the real size on success.
  // A Worker eviction between the claim and the put (or any other abandoned
  // claim not cleaned up by the catch block) leaves a stuck missing=1 row whose
  // placeholder size is really the WebDAV file's size — summing it here
  // attributed that WebDAV-sourced byte count to the 'r2' bucket even though
  // nothing was ever written to R2 for it. Every other song_instances query in
  // this codebase already filters missing=0; this was the one that didn't.
  const breakdownResult = await db.prepare(`
    SELECT
      CASE
        WHEN storage_uri LIKE 'r2://%'       THEN 'r2'
        WHEN storage_uri LIKE 'webdav://%'   THEN 'webdav'
        WHEN storage_uri LIKE 's3://%'       THEN 's3'
        WHEN storage_uri LIKE 'subsonic://%' THEN 'subsonic'
        WHEN storage_uri LIKE 'url://%'      THEN 'url'
        ELSE 'other'
      END AS source_type,
      COUNT(*)                        AS count,
      SUM(COALESCE(size, 0))          AS bytes
    FROM song_instances
    WHERE missing = 0
    GROUP BY source_type
    ORDER BY bytes DESC
  `).all<{ source_type: string; count: number; bytes: number }>();

  const coversRow = await db
    .prepare("SELECT COUNT(*) AS n FROM albums WHERE cover_r2_key IS NOT NULL AND cover_r2_key != ''")
    .first<{ n: number }>();

  const freeAllocStr = await getFeatureString(c.env, "r2_free_allocation_gb", "10");
  const freeAllocationGb = Math.max(0, parseFloat(freeAllocStr) || 10);

  return c.json({
    ok: true,
    breakdown: breakdownResult.results,
    r2CoverCount: coversRow?.n ?? 0,
    freeAllocationGb,
  });
});
