// 055 — User CRUD. Originally split out of endpoints/admin.ts with XML envelopes
// kept verbatim during the bucket refactor.
// 072 — JSON-ified to match the rest of the /edgesonic bucket (work/*, cf/*,
// features/*, users/setAvatar all return JSON). The Subsonic-XML shape was a
// historical leftover and forced Users.vue / Dashboard.vue to lean on a
// hand-rolled `parseXmlAttrs` regex that was easy to break.
// Shapes:
//   list   → { ok: true, users: [{ username, level, enabled }] }
//   get    → { ok: true, user: { username, level, enabled } }
//   create → { ok: true }
//   update → { ok: true }
//   delete → { ok: true }
// Errors: `{ ok: false, error }` with the appropriate HTTP status (400 / 403 /
// 404), matching setAvatar's convention from 064.
import { Hono } from "hono";
import { permissionMiddleware, sha256 } from "../../auth";
import { hasPermission } from "../../utils/permissions";
import type { User } from "../../types/entities";

export const usersRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

usersRoutes.get("/users/list", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const result = await db.prepare("SELECT username, level, enabled FROM users ORDER BY created_at ASC").all<{
    username: string; level: number; enabled: number;
  }>();
  const users = result.results.map((u) => ({
    username: u.username,
    level: u.level,
    enabled: !!u.enabled,
  }));
  return c.json({ ok: true, users });
});

usersRoutes.post("/users/create", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password: string; level?: number }>();
  if (!body.username || !body.password) {
    return c.json({ ok: false, error: "Missing username or password" }, 400);
  }
  const level = body.level ?? 1;
  if (level < 0 || level > 3) {
    return c.json({ ok: false, error: "Invalid level (0-3)" }, 400);
  }
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT OR REPLACE INTO users (username, master_password, level, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
  ).bind(body.username, await sha256(body.password), level, now, now).run();
  return c.json({ ok: true });
});

usersRoutes.get("/users/get", async (c) => {
  const username = c.req.query("username");
  if (!username) {
    return c.json({ ok: false, error: "Missing username" }, 400);
  }
  const db = c.env.DB;
  const user = await db.prepare(
    "SELECT username, level, enabled FROM users WHERE username = ?"
  ).bind(username).first<{ username: string; level: number; enabled: number }>();
  if (!user) {
    return c.json({ ok: false, error: "User not found" }, 404);
  }
  return c.json({
    ok: true,
    user: {
      username: user.username,
      level: user.level,
      enabled: !!user.enabled,
    },
  });
});

usersRoutes.post("/users/update", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string; password?: string; level?: number; enabled?: number }>();
  if (!body.username) {
    return c.json({ ok: false, error: "Missing username" }, 400);
  }
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  if (body.password) {
    await db.prepare(
      "UPDATE users SET master_password = ?, updated_at = ? WHERE username = ?"
    ).bind(await sha256(body.password), now, body.username).run();
  }
  if (body.level !== undefined) {
    if (body.level < 0 || body.level > 3) {
      return c.json({ ok: false, error: "Invalid level (0-3)" }, 400);
    }
    await db.prepare(
      "UPDATE users SET level = ?, updated_at = ? WHERE username = ?"
    ).bind(body.level, now, body.username).run();
  }
  if (body.enabled !== undefined) {
    await db.prepare(
      "UPDATE users SET enabled = ?, updated_at = ? WHERE username = ?"
    ).bind(body.enabled ? 1 : 0, now, body.username).run();
  }
  return c.json({ ok: true });
});

usersRoutes.post("/users/delete", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{ username: string }>();
  if (!body.username) {
    return c.json({ ok: false, error: "Missing username" }, 400);
  }
  const db = c.env.DB;
  await db.prepare("DELETE FROM users WHERE username = ?").bind(body.username).run();
  return c.json({ ok: true });
});

// ============================================================================
// 064 — POST /edgesonic/users/setAvatar
// ----------------------------------------------------------------------------
// Body (JSON): { username, imageBase64, mimeType }
//   • imageBase64 — raw base64 OR data: URL form. Leading "data:image/..;base64,"
//     prefix is stripped.
//   • mimeType    — must be 'image/jpeg' or 'image/png'. Other mimes (webp / gif
//     / avif) are rejected to keep the getAvatar fallback path simple and to
//     match what older Subsonic clients can render reliably.
// Auth: self-edit always allowed; caller.level>=2 may edit anyone (mirrors
//   changePassword in subsonic/account.ts).
// Size: hard cap 500 KB AFTER base64 decode. The frontend already canvas-
//   compresses to ≤100 KB JPEG at 200×200; this is just a sanity guard so a
//   malicious client can't slam R2 with multi-MB payloads.
// Storage: R2 key `avatars/<username>.<ext>` (overwrite). Reads `users` for
//   the old key — we keep the same key when ext matches; if the extension
//   changes (PNG ↔ JPEG) we'd technically leak the old object, but R2 cost is
//   negligible and getAvatar reads the column-stored key so users always see
//   the latest upload.
// Response: JSON `{ ok: true, avatarKey }`. Other users endpoints emit XML for
// compatibility with the legacy admin.ts shape, but the avatar pair (get/set)
// already lives outside that XML envelope (getAvatar serves binary) so JSON
// is consistent and easier for the Vue UI to consume.
// ============================================================================
usersRoutes.post("/users/setAvatar", async (c) => {
  const body = await c.req.json<{
    username?: string;
    imageBase64?: string;
    mimeType?: string;
  }>().catch(() => ({} as { username?: string; imageBase64?: string; mimeType?: string }));

  const targetUsername = body.username || "";
  const imageBase64 = body.imageBase64 || "";
  const mimeType = (body.mimeType || "").toLowerCase();

  if (!targetUsername || !imageBase64 || !mimeType) {
    return c.json({ ok: false, error: "Missing username / imageBase64 / mimeType" }, 400);
  }

  // ---- Auth: self or manage_users -----------------------------------------
  // 087 — cross-user write gated by manage_users (matches the list/create/
  // update/delete endpoints in this file). Pre-087 used a hardcoded
  // `caller.level < 2` which violated the permission-model rule.
  const caller = c.get("user");
  const isSelf = caller.username === targetUsername;
  if (!isSelf) {
    const canManage = await hasPermission(c.env.DB, caller, "manage_users");
    if (!canManage) {
      return c.json({ ok: false, error: "manage_users permission required" }, 403);
    }
  }

  // ---- Validate target exists --------------------------------------------
  const db = c.env.DB;
  const target = await db
    .prepare("SELECT username FROM users WHERE username = ?")
    .bind(targetUsername)
    .first<{ username: string }>();
  if (!target) {
    return c.json({ ok: false, error: "User not found" }, 404);
  }

  // ---- Validate mime -----------------------------------------------------
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    return c.json({ ok: false, error: "Invalid mime type (must be image/jpeg or image/png)" }, 400);
  }
  const ext = mimeType === "image/png" ? "png" : "jpg";

  // ---- Decode base64 (tolerant of data: URL prefix) ----------------------
  const stripped = imageBase64.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, "");
  let bytes: Uint8Array;
  try {
    // atob is available in Workers; Buffer is not.
    const binary = atob(stripped);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return c.json({ ok: false, error: "Invalid base64 payload" }, 400);
  }

  // ---- Size guard --------------------------------------------------------
  // 500 KB is generous — the frontend should send ≤100 KB. We reject larger
  // payloads early so R2 doesn't see junk.
  const MAX_BYTES = 500 * 1024;
  if (bytes.length === 0) {
    return c.json({ ok: false, error: "Empty image payload" }, 400);
  }
  if (bytes.length > MAX_BYTES) {
    return c.json({ ok: false, error: `Image too large (>${MAX_BYTES} bytes)` }, 400);
  }

  // ---- Write to R2 -------------------------------------------------------
  const avatarKey = `avatars/${targetUsername}.${ext}`;
  await c.env.MUSIC_BUCKET.put(avatarKey, bytes, {
    httpMetadata: { contentType: mimeType },
  });

  // ---- Persist key + bump updated_at -------------------------------------
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE users SET avatar_r2_key = ?, updated_at = ? WHERE username = ?")
    .bind(avatarKey, now, targetUsername)
    .run();

  return c.json({ ok: true, avatarKey });
});
