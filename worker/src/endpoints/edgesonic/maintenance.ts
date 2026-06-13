// 078 — Operational maintenance endpoints.
//
// These are one-shot admin tools for tidying up the database state, not part
// of any user-facing protocol. Each endpoint is super-admin only (level >= 3)
// and safe to re-run (idempotent / "no-op when nothing to do").
//
// First endpoint: cleanupDuplicateCovers.
//   Background: Before 076 the getCoverArt fallback path (resolveAlbumCover)
//   would write the same parent-directory cover.jpg to a distinct R2 key per
//   album, so a folder hosting 25 albums ended up with 25 R2 keys whose
//   *contents* were identical (one anime character shown for every album).
//   076 removed the fallback, but the 25 historical keys are still bound to
//   their albums in D1. This endpoint releases all but one binding per
//   duplicate key, letting each freed album re-resolve its own cover on the
//   next /rest/getCoverArt call (which now correctly 404s if no per-album
//   cover exists, prompting <img onerror> to fall back to the UI placeholder
//   — the desired behaviour).
//
//   We do NOT delete the R2 objects: the survivor row in each group still
//   needs the bytes. R2 lifecycle / orphan sweep is a separate concern.

import { Hono } from "hono";
import type { User } from "../../types/entities";

export const maintenanceRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// ---------------------------------------------------------------------------
// POST /edgesonic/maintenance/cleanupDuplicateCovers
// ---------------------------------------------------------------------------
// Response: { ok: true, groups, cleared }
//   - groups:  number of distinct cover_r2_key values that had >1 album
//   - cleared: number of albums whose cover_r2_key was set to NULL
//
// Algorithm:
//   1. SELECT cover_r2_key, COUNT(*) FROM albums GROUP BY ... HAVING n > 1
//   2. For each duplicated key, SELECT ids ORDER BY id ASC.
//      Survivor = ids[0]; the rest get cover_r2_key=NULL.
//
// Why "id ASC" as the survivor rule? Stable + deterministic + matches the
// `id` we generate during scan (which itself is created-order-ish), so the
// album that was created first keeps the cover binding. A future variant
// could pick by song_count or updated_at, but the simplest tie-break is also
// the easiest to reason about during recovery.
maintenanceRoutes.post("/maintenance/cleanupDuplicateCovers", async (c) => {
  const env = c.env as Env;
  const user = c.get("user");
  if (user.level < 3) {
    return c.json({ ok: false, error: "Admin level required" }, 403);
  }

  // Aggregate the duplicate cover_r2_key values. We deliberately skip rows
  // where cover_r2_key IS NULL — those are albums without a cover at all and
  // they're not the problem.
  const dupes = (await env.DB.prepare(
    `SELECT cover_r2_key AS cover_r2_key, COUNT(*) AS n
     FROM albums
     WHERE cover_r2_key IS NOT NULL
     GROUP BY cover_r2_key
     HAVING n > 1
     ORDER BY n DESC`,
  ).all<{ cover_r2_key: string; n: number }>()).results;

  if (dupes.length === 0) {
    return c.json({ ok: true, groups: 0, cleared: 0 });
  }

  let cleared = 0;
  for (const dup of dupes) {
    // Pull the album ids that share this cover key, oldest first. We can't
    // use GROUP_CONCAT here because we need ORDER BY id ASC to pick a stable
    // survivor; a separate SELECT is the cheapest correct form.
    const ids = (await env.DB.prepare(
      `SELECT id
       FROM albums
       WHERE cover_r2_key = ?
       ORDER BY id ASC`,
    ).bind(dup.cover_r2_key).all<{ id: string }>()).results;

    // Defensive: a race could have rewritten the binding between the two
    // queries. If only one row remains, skip — nothing duplicated anymore.
    if (ids.length < 2) continue;

    // ids[0] is the survivor; release the rest. We could do an `IN (?,?,?)`
    // but D1's bind parameter limit (100) plus the fact that we'd need to
    // build the placeholder list dynamically makes a per-row UPDATE simpler
    // and not much slower (each group is ~25 rows max per the 076 finding).
    for (let i = 1; i < ids.length; i++) {
      const result = await env.DB.prepare(
        `UPDATE albums
         SET cover_r2_key = NULL,
             updated_at = unixepoch()
         WHERE id = ? AND cover_r2_key = ?`,
      ).bind(ids[i].id, dup.cover_r2_key).run();
      // Only count rows we actually changed — if another process raced us
      // (e.g. an admin manually re-bound the cover during the sweep) the
      // WHERE-constrained UPDATE turns into a no-op.
      if (result.meta.changes > 0) cleared++;
    }
  }

  return c.json({ ok: true, groups: dupes.length, cleared });
});
