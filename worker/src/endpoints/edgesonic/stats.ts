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
// plus R2 cover art count + bytes (via R2 list) and the user-configured
// free-tier allocation for cost estimation. Super-admin only (billing data).
statsRoutes.get("/stats/storage", async (c) => {
  const user = c.get("user");
  if (user.level < 3) return c.json({ ok: false, error: "Not authorized" }, 403);

  const db = c.env.DB;

  // storage_uri r2://cache/webdav/...) don't inflate the 'r2' bucket. Only
  // source_type != 'cached' with r2:// URIs count as native R2 storage.
  //
 // The bucket CASE is repeated in GROUP BY rather than referenced by its
  // "source_type" alias: song_instances has a REAL column also named
  // source_type, and SQLite resolves a bare GROUP BY identifier that matches
  // BOTH an input column and an output alias to the INPUT column — so
  // `GROUP BY source_type` silently grouped rows by the raw 'original'/
  // 'cached' column value instead of the computed bucket, merging the r2://
  // and webdav:// rows (both source_type='original') into one bogus group.
  // Repeating the full expression sidesteps the ambiguity while keeping the
  // JSON response's `source_type` key unchanged.
  const bucketCase = `
    CASE
      WHEN source_type = 'cached'          THEN 'cached'
      WHEN storage_uri LIKE 'r2://%'       THEN 'r2'
      WHEN storage_uri LIKE 'webdav://%'   THEN 'webdav'
      WHEN storage_uri LIKE 's3://%'       THEN 's3'
      WHEN storage_uri LIKE 'subsonic://%' THEN 'subsonic'
      WHEN storage_uri LIKE 'url://%'      THEN 'url'
      ELSE 'other'
    END`;
  const breakdownResult = await db.prepare(`
    SELECT
      ${bucketCase} AS source_type,
      COUNT(*)                        AS count,
      SUM(COALESCE(size, 0))          AS bytes
    FROM song_instances
    WHERE missing = 0
    GROUP BY ${bucketCase}
    ORDER BY bytes DESC
  `).all<{ source_type: string; count: number; bytes: number }>();

  // covers/ prefix holds album/artist images; cache/ holds sized variants.
  const coversRow = await db
    .prepare("SELECT COUNT(*) AS n FROM albums WHERE cover_r2_key IS NOT NULL AND cover_r2_key != ''")
    .first<{ n: number }>();
  const r2CoverCount = coversRow?.n ?? 0;

  // R2 cover bytes: list objects under covers/ prefix, sum sizes. R2 list
  // returns max 1000 per call; paginate. This is a billing stat so the extra
  // sub-requests are acceptable (super-admin only, dashboard one-shot).
  let r2CoverBytes = 0;
  let r2Cursor: string | undefined;
  try {
    do {
      const listed = await c.env.MUSIC_BUCKET.list({ prefix: "covers/", cursor: r2Cursor, limit: 1000 });
      for (const obj of listed.objects) r2CoverBytes += obj.size;
      r2Cursor = listed.truncated ? listed.cursor : undefined;
    } while (r2Cursor);
  } catch { /* R2 list failed — show count without bytes */ }

  const freeAllocStr = await getFeatureString(c.env, "r2_free_allocation_gb", "10");
  const freeAllocationGb = Math.max(0, parseFloat(freeAllocStr) || 10);

  return c.json({
    ok: true,
    breakdown: breakdownResult.results,
    r2CoverCount,
    r2CoverBytes,
    freeAllocationGb,
  });
});
