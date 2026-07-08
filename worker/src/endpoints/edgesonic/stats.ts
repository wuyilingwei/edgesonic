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
