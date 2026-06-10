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
import { invalidateFeature } from "../utils/features";
import type { User } from "../types/entities";

// Feature flag management (DESIGN.md §3.3).
// Both endpoints are in SESSION_ONLY_PATHS — authMiddleware already guarantees
// a web-session credential. Responses are JSON (web extension face).
export const featuresRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

featuresRoutes.get("/rest/getFeatures", async (c) => {
  const user = c.get("user");
  if (user.level < 2) {
    return c.json({ ok: false, error: "Admin level required" }, 403);
  }
  const result = await c.env.DB.prepare(
    "SELECT key, value, description, updated_at FROM features ORDER BY key ASC"
  ).all<{ key: string; value: number; description: string | null; updated_at: number }>();

  return c.json({
    ok: true,
    instanceId: c.env.INSTANCE_ID,
    features: result.results,
  });
});

featuresRoutes.post("/rest/updateFeature", async (c) => {
  const user = c.get("user");
  const perm = await c.env.DB.prepare(
    "SELECT enabled FROM user_permissions WHERE level = ? AND permission = 'manage_permissions'"
  )
    .bind(user.level)
    .first<{ enabled: number }>();
  if (!perm || !perm.enabled) {
    return c.json({ ok: false, error: "manage_permissions permission required" }, 403);
  }

  let body: { key?: string; value?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!body.key || (body.value !== 0 && body.value !== 1)) {
    return c.json({ ok: false, error: "Expected { key, value: 0|1 }" }, 400);
  }

  const result = await c.env.DB.prepare(
    "UPDATE features SET value = ?, updated_at = ? WHERE key = ?"
  )
    .bind(body.value, Math.floor(Date.now() / 1000), body.key)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: `Unknown feature: ${body.key}` }, 404);
  }

  await invalidateFeature(c.env, body.key);
  return c.json({ ok: true });
});
