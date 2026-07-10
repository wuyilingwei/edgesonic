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
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { callCfApi } from "./cf";
import type { User } from "../../types/entities";

export const permissionsRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

permissionsRoutes.get("/permissions/list", permissionMiddleware("manage_permissions"), async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(
    "SELECT level, permission, enabled FROM user_permissions ORDER BY level ASC, permission ASC"
  ).all<{ level: number; permission: string; enabled: number }>();

  const grouped: Record<number, Array<{ permission: string; enabled: number }>> = {};
  for (const r of rows.results) {
    if (!grouped[r.level]) grouped[r.level] = [];
    grouped[r.level].push({ permission: r.permission, enabled: r.enabled });
  }

  return c.text(
    subsonicOK({
      permissions: Object.entries(grouped).map(([level, perms]) => ({
        _attributes: { level },
        // PermissionsMatrix.vue's parser matches each <permission> child tag
        // independently (a flat regex over the whole document, not a nested
        // walk of <permissions level="X"> blocks) — it needs `level` on the
        // child itself, not just the parent wrapper, or every row silently
        // defaults to level 0 (which is exactly the bug this fixes: guest
        // picking up every permission, 1/2/3 reading as unchecked).
        permission: perms.map((p) => ({
          _attributes: {
            level,
            name: p.permission,
            enabled: String(p.enabled),
          },
        })),
      })),
    }),
    200, XML,
  );
});

// Single-cell toggle kept for any future non-batch caller, but the
// Settings UI no longer uses this (real-time-per-toggle save was replaced
// by the batch /permissions/save below + an explicit Save button).
permissionsRoutes.post("/permissions/update", permissionMiddleware("manage_permissions"), async (c) => {
  const body = await c.req.json<{ level: number; permission: string; enabled?: number }>();
  if (body.level === undefined || !body.permission) {
    return c.text(subsonicError(0, "Missing level or permission"), 400, XML);
  }
  if (body.level < 0 || body.level > 3) {
    return c.text(subsonicError(0, "Invalid level (0-3)"), 400, XML);
  }
  if (body.enabled === undefined) {
    return c.text(subsonicError(0, "Missing enabled"), 400, XML);
  }
  const db = c.env.DB;
  await db.prepare(
    "UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?"
  ).bind(body.enabled ? 1 : 0, body.level, body.permission).run();

  return c.text(subsonicOK({}), 200, XML);
});

// ============================================================================
// POST /edgesonic/permissions/save  body: { permissions: Array<{level, name, enabled}> }
// ============================================================================
// The whole-matrix save behind the Settings UI's explicit Save button.
// Two steps:
//   1. D1 is always updated first — the durable source of truth and the
//      fallback path permissionMiddleware/hasPermission use when the env
//      override below is unset or fails to parse.
//   2. Best-effort: if CF_API_TOKEN/CF_ACCOUNT_ID are configured (054), push
//      the same matrix as the PERMISSIONS_OVERRIDE Workers Secret (same
//      write pattern as cf.ts:setToken) so subsequent requests skip the D1
//      round-trip entirely. A push failure does NOT fail the request — D1
//      already has the update, so behaviour is correct either way, just one
//      D1 read slower per permission check until the next successful push.
permissionsRoutes.post("/permissions/save", permissionMiddleware("manage_permissions"), async (c) => {
  const body = await c.req.json<{ permissions?: Array<{ level: number; name: string; enabled: boolean }> }>().catch(() => null);
  if (!body || !Array.isArray(body.permissions) || body.permissions.length === 0) {
    return c.json({ ok: false, error: "Missing permissions" }, 400);
  }
  for (const p of body.permissions) {
    if (typeof p.level !== "number" || p.level < 0 || p.level > 3 || typeof p.name !== "string" || !p.name) {
      return c.json({ ok: false, error: `Invalid entry: ${JSON.stringify(p)}` }, 400);
    }
  }
  // manage_permissions is hardcoded to level 3 at read time (hasPermission),
  // but keep the D1 rows themselves honest too — never persist a row that
  // would claim it's grantable to a lower level, even from a super-admin's
  // batch save (a stray checkbox from some future UI regression shouldn't
  // be able to write a misleading row).
  const entries = body.permissions.filter((p) => p.name !== "manage_permissions");

  const db = c.env.DB;
  const stmts = entries.map((p) =>
    db.prepare("UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?")
      .bind(p.enabled ? 1 : 0, p.level, p.name));
  for (let i = 0; i < stmts.length; i += 80) {
    await db.batch(stmts.slice(i, i + 80));
  }

  let envPushed = false;
  let envError: string | undefined;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (token && accountId) {
    // Merge onto the *current* D1 state (not just this request's partial
    // patch) so the secret always mirrors the full matrix, matching what
    // /permissions/list would return.
    const rows = await db.prepare("SELECT level, permission, enabled FROM user_permissions").all<{ level: number; permission: string; enabled: number }>();
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const r of rows.results) {
      if (!matrix[r.level]) matrix[r.level] = {};
      matrix[r.level][r.permission] = r.enabled === 1;
    }
    try {
      const workerName = c.env.WORKER_NAME || "edgesonic";
      await callCfApi(
        token,
        `/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: "PERMISSIONS_OVERRIDE",
            text: JSON.stringify(matrix),
            type: "secret_text",
          }),
        },
      );
      envPushed = true;
    } catch (e) {
      envError = e instanceof Error ? e.message : String(e);
    }
  }

  return c.json({ ok: true, saved: entries.length, envPushed, envError });
});
