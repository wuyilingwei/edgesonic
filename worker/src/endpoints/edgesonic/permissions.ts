// 055 — Permission matrix CRUD. Split out of the old endpoints/admin.ts.
import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const permissionsRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

permissionsRoutes.get("/permissions/list", permissionMiddleware("manage_permissions"), async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(
    "SELECT level, permission, enabled, max_rph FROM user_permissions ORDER BY level ASC, permission ASC"
  ).all<{ level: number; permission: string; enabled: number; max_rph: number }>();

  const grouped: Record<number, Array<{ permission: string; enabled: number; max_rph: number }>> = {};
  for (const r of rows.results) {
    if (!grouped[r.level]) grouped[r.level] = [];
    grouped[r.level].push({ permission: r.permission, enabled: r.enabled, max_rph: r.max_rph });
  }

  return c.text(
    subsonicOK({
      permissions: Object.entries(grouped).map(([level, perms]) => ({
        _attributes: { level },
        permission: perms.map((p) => ({
          _attributes: {
            name: p.permission,
            enabled: String(p.enabled),
            maxRph: String(p.max_rph),
          },
        })),
      })),
    }),
    200, XML,
  );
});

permissionsRoutes.post("/permissions/update", permissionMiddleware("manage_permissions"), async (c) => {
  const body = await c.req.json<{ level: number; permission: string; enabled?: number; max_rph?: number }>();
  if (body.level === undefined || !body.permission) {
    return c.text(subsonicError(0, "Missing level or permission"), 400, XML);
  }
  if (body.level < 0 || body.level > 3) {
    return c.text(subsonicError(0, "Invalid level (0-3)"), 400, XML);
  }
  const db = c.env.DB;

  if (body.enabled !== undefined) {
    await db.prepare(
      "UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?"
    ).bind(body.enabled ? 1 : 0, body.level, body.permission).run();
  }
  if (body.max_rph !== undefined) {
    await db.prepare(
      "UPDATE user_permissions SET max_rph = ? WHERE level = ? AND permission = ?"
    ).bind(body.max_rph, body.level, body.permission).run();
  }

  return c.text(subsonicOK({}), 200, XML);
});
