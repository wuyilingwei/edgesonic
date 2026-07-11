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

// /storage/sources/* bucket per the 4-tier API refactor. All endpoints require
// a web-session credential (enforced by auth.ts prefix check) plus the
// manage_sources permission.
import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const sourcesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// R2 is the always-present built-in storage backend (accessed via the
// native MUSIC_BUCKET binding, never HTTP). Uploads/clone/hotcache/transcode
// all write song_instances.source_id='r2-local' directly without ever
// creating a storage_sources row, so R2 has historically been completely
// invisible on this page
// it has no edit function" (there was no entry to edit at all). If no real
// row exists yet we synthesise one here so it always shows up; /sources/
// update upserts it into a real row the first time an admin actually edits
// it (name/root_path/mode — base_url/credentials don't apply to R2).
export const R2_BUILTIN_ID = "r2-local";
export function synthesizeR2Row() {
  return {
    id: R2_BUILTIN_ID, type: "r2", name: "R2", base_url: "",
    username: null, presign_username: null, root_path: "", region: "auto",
    last_sync: null, enabled: 1, mode: "library",
  };
}

sourcesRoutes.get("/sources/list", permissionMiddleware("manage_sources"), async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    `SELECT id, type, name, base_url, username,
            presign_username,
            root_path, region, last_sync, enabled, mode
     FROM storage_sources ORDER BY created_at ASC`
  ).all<{
    id: string; type: string; name: string; base_url: string; username: string | null;
    presign_username: string | null;
    root_path: string | null; region: string | null; last_sync: number | null; enabled: number;
    mode: string;
  }>();
  const rows = result.results;
  if (!rows.some((r) => r.type === "r2")) {
    // Appended, not prepended — keeps existing real sources' relative order
    // (and their position as "first" in the XML) unchanged for callers that
    // don't scope by id.
    rows.push(synthesizeR2Row());
  }

  // Per-source storage footprint (file count + total bytes), keyed by
  // song_instances.source_id — this is also how R2's instances tie back to
  // the synthesised row above (they all carry source_id='r2-local').
  const sizeRows = await db.prepare(
    `SELECT source_id, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
     FROM song_instances WHERE missing = 0 GROUP BY source_id`
  ).all<{ source_id: string; n: number; bytes: number }>();
  const sizeBySource = new Map(sizeRows.results.map((r) => [r.source_id, r]));

  const sources = rows.map((s) => {
    const sz = sizeBySource.get(s.id);
    return {
      _attributes: {
        id: s.id, type: s.type, name: s.name ?? "",
        baseUrl: s.base_url,
        rootPath: s.root_path ?? "",
        username: s.username ?? "", enabled: String(!!s.enabled),
        lastSync: s.last_sync ? String(s.last_sync) : "0",
        // 089 S2 — 'library' | 'sync_only'
        mode: s.mode ?? "library",
        region: s.region ?? "us-east-1",
        presignUsername: s.presign_username ?? "",
        fileCount: String(sz?.n ?? 0),
        sizeBytes: String(sz?.bytes ?? 0),
        // R2 has no base_url/username — account id + bucket name are its
        // equivalent "where does this actually point to" detail fields.
        ...(s.type === "r2" ? {
          accountId: c.env.CF_ACCOUNT_ID || "",
          bucketName: c.env.R2_BUCKET_NAME || "",
        } : {}),
      },
    };
  });
  return c.text(subsonicOK({ storageSources: { source: sources } }), 200, XML);
});

sourcesRoutes.post("/sources/add", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    type: string; base_url: string; name?: string; username?: string;
    password?: string; root_path?: string; mode?: string; region?: string;
    presign_username?: string; presign_password?: string;
  }>();
  if (!body.type || !body.base_url) {
    return c.text(subsonicError(0, "Missing type or base_url"), 400, XML);
  }
  // 089 S2 — validate mode
  const mode = body.mode ?? "library";
  if (mode !== "library" && mode !== "sync_only") {
    return c.text(subsonicError(0, "Invalid mode: must be 'library' or 'sync_only'"), 400, XML);
  }
  const region = body.region || "us-east-1";
  const db = c.env.DB;
  const id = crypto.randomUUID().substring(0, 8);
  const now = Math.floor(Date.now() / 1000);
  const password = body.password ?? "";
  await db.prepare(
    `INSERT INTO storage_sources
       (id, type, name, base_url, username, password, root_path, region, mode, presign_username, presign_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body.type, body.name || "", body.base_url, body.username || null,
    password, body.root_path || "", region, mode,
    body.presign_username || null, body.presign_password || null,
    now, now,
  ).run();
  return c.text(subsonicOK({}), 200, XML);
});

sourcesRoutes.post("/sources/update", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    id: string; name?: string; base_url?: string; username?: string; password?: string;
    root_path?: string; enabled?: number; mode?: string; region?: string;
    presign_username?: string; presign_password?: string;
  }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  // 089 S2 — validate mode if provided
  if (body.mode !== undefined && body.mode !== "library" && body.mode !== "sync_only") {
    return c.text(subsonicError(0, "Invalid mode: must be 'library' or 'sync_only'"), 400, XML);
  }
  const db = c.env.DB;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); binds.push(body.name); }
  if (body.base_url !== undefined) { sets.push("base_url = ?"); binds.push(body.base_url); }
  if (body.username !== undefined) { sets.push("username = ?"); binds.push(body.username || null); }
  if (body.password !== undefined && body.password !== "") {
    sets.push("password = ?");
    binds.push(body.password);
  }
  if (body.root_path !== undefined) { sets.push("root_path = ?"); binds.push(body.root_path); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0); }
  // 089 S2 — update mode
  if (body.mode !== undefined) { sets.push("mode = ?"); binds.push(body.mode); }
  if (body.region !== undefined && body.region !== "") { sets.push("region = ?"); binds.push(body.region); }
  if (body.presign_username !== undefined) { sets.push("presign_username = ?"); binds.push(body.presign_username || null); }
  if (body.presign_password !== undefined) { sets.push("presign_password = ?"); binds.push(body.presign_password || null); }
  if (sets.length === 0) {
    return c.text(subsonicError(0, "Nothing to update"), 400, XML);
  }
  sets.push("updated_at = ?");
  binds.push(Math.floor(Date.now() / 1000), body.id);
  const result = await db.prepare(`UPDATE storage_sources SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  if (!result.meta.changes) {
    // The built-in R2 row is synthesised by /sources/list, not stored
    // in D1 until an admin actually saves an edit for it. First edit here
    // becomes an INSERT instead of a 404.
    if (body.id === R2_BUILTIN_ID) {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO storage_sources
           (id, type, name, base_url, username, password, root_path, region, mode, presign_username, presign_password, enabled, created_at, updated_at)
         VALUES (?, 'r2', ?, '', NULL, '', ?, 'auto', ?, NULL, NULL, ?, ?, ?)`
      ).bind(
        R2_BUILTIN_ID, body.name ?? "R2", body.root_path ?? "",
        body.mode ?? "library", body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
        now, now,
      ).run();
      return c.text(subsonicOK({}), 200, XML);
    }
    return c.text(subsonicError(70, "Source not found"), 404, XML);
  }
  return c.text(subsonicOK({}), 200, XML);
});

sourcesRoutes.post("/sources/delete", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{ id: string }>();
  if (!body.id) {
    return c.text(subsonicError(0, "Missing id"), 400, XML);
  }
  // R2 is built-in; deleting the row is a no-op in practice (the next
  // /sources/list call resynthesises it), but reject explicitly so the
  // response isn't misleadingly "ok" for an action that didn't actually
  // remove anything meaningful.
  if (body.id === R2_BUILTIN_ID) {
    return c.text(subsonicError(0, "Cannot delete the built-in R2 source"), 400, XML);
  }
  const db = c.env.DB;
  await db.prepare("DELETE FROM storage_sources WHERE id = ?").bind(body.id).run();
  return c.text(subsonicOK({}), 200, XML);
});

