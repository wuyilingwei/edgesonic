// 055 — Storage source CRUD. Split out of the old endpoints/admin.ts into the
// /storage/sources/* bucket per the 4-tier API refactor. All endpoints require
// a web-session credential (enforced by auth.ts prefix check) plus the
// manage_sources permission.
import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const sourcesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

sourcesRoutes.get("/sources/list", permissionMiddleware("manage_sources"), async (c) => {
  const db = c.env.DB;
  const result = await db.prepare("SELECT * FROM storage_sources ORDER BY created_at ASC").all<{
    id: string; type: string; name: string; base_url: string; username: string | null;
    root_path: string | null; last_sync: number | null; enabled: number;
  }>();
  const sources = result.results.map((s) => ({
    _attributes: {
      id: s.id, type: s.type, name: s.name ?? "",
      baseUrl: s.base_url,
      rootPath: s.root_path ?? "",
      username: s.username ?? "", enabled: String(!!s.enabled),
      lastSync: s.last_sync ? String(s.last_sync) : "0",
    },
  }));
  return c.text(subsonicOK({ storageSources: { source: sources } }), 200, XML);
});

sourcesRoutes.post("/sources/add", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ type: string; base_url: string; name?: string; username?: string; password?: string; root_path?: string }>();
  if (!body.type || !body.base_url) {
    return c.text(subsonicError(0, "Missing type or base_url"), 400, XML);
  }
  const db = c.env.DB;
  const id = crypto.randomUUID().substring(0, 8);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, body.type, body.name || "", body.base_url, body.username || null, body.password || null, body.root_path || "", now, now).run();
  return c.text(subsonicOK({}), 200, XML);
});

sourcesRoutes.post("/sources/update", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    id: string; name?: string; base_url?: string; username?: string; password?: string;
    root_path?: string; enabled?: number;
  }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  const db = c.env.DB;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); binds.push(body.name); }
  if (body.base_url !== undefined) { sets.push("base_url = ?"); binds.push(body.base_url); }
  if (body.username !== undefined) { sets.push("username = ?"); binds.push(body.username || null); }
  if (body.password !== undefined && body.password !== "") { sets.push("password = ?"); binds.push(body.password); }
  if (body.root_path !== undefined) { sets.push("root_path = ?"); binds.push(body.root_path); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0); }
  if (sets.length === 0) {
    return c.text(subsonicError(0, "Nothing to update"), 400, XML);
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000), body.id);
  const result = await db.prepare(`UPDATE storage_sources SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (!result.meta.changes) {
    return c.text(subsonicError(70, "Source not found"), 404, XML);
  }
  return c.text(subsonicOK({}), 200, XML);
});

sourcesRoutes.post("/sources/delete", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  const db = c.env.DB;
  await db.prepare("DELETE FROM storage_sources WHERE id = ?").bind(body.id).run();
  return c.text(subsonicOK({}), 200, XML);
});
