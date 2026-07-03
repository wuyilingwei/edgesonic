// 055 — Storage source CRUD. Split out of the old endpoints/admin.ts into the
// /storage/sources/* bucket per the 4-tier API refactor. All endpoints require
// a web-session credential (enforced by auth.ts prefix check) plus the
// manage_sources permission.
//
// 068 — Passwords are stored AES-256-GCM encrypted in `password_encrypted`
// (`v1:<base64url>` blob) when env.STORAGE_KEY is configured. The legacy
// `password` column is left in place for back-compat (and is empty on
// freshly-written rows). Adapters read whichever is set via
// getDecryptedPassword(). The /sources/migratePasswords admin endpoint walks
// the table and rewrites legacy plaintext rows in bulk.
import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { encryptPassword, isEncryptedPassword } from "../../utils/sourceCrypto";
import type { User } from "../../types/entities";

export const sourcesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// Returns the value to write into password_encrypted (or null) and into the
// legacy password column. Centralises the env.STORAGE_KEY availability check
// so add/update share identical semantics.
async function preparePasswordWrite(
  plaintext: string,
  env: Env,
): Promise<{ password_encrypted: string | null; password: string }> {
  const key = env.STORAGE_KEY;
  if (key && key.length > 0) {
    // STORAGE_KEY configured → encrypt and blank the legacy column so a D1
    // dump doesn't expose plaintext alongside the ciphertext.
    return { password_encrypted: await encryptPassword(plaintext, key), password: "" };
  }
  // No STORAGE_KEY → write legacy plaintext (back-compat path). The "encrypted"
  // badge in the UI surfaces this case so the admin knows to push the secret.
  return { password_encrypted: null, password: plaintext };
}

sourcesRoutes.get("/sources/list", permissionMiddleware("manage_sources"), async (c) => {
  const db = c.env.DB;
  const result = await db.prepare(
    `SELECT id, type, name, base_url, username, password, password_encrypted,
            root_path, last_sync, enabled, mode
     FROM storage_sources ORDER BY created_at ASC`
  ).all<{
    id: string; type: string; name: string; base_url: string; username: string | null;
    password: string | null; password_encrypted: string | null;
    root_path: string | null; last_sync: number | null; enabled: number;
    mode: string;
  }>();
  const sources = result.results.map((s) => ({
    _attributes: {
      id: s.id, type: s.type, name: s.name ?? "",
      baseUrl: s.base_url,
      rootPath: s.root_path ?? "",
      username: s.username ?? "", enabled: String(!!s.enabled),
      lastSync: s.last_sync ? String(s.last_sync) : "0",
      // 068 — Boolean attr so Sources.vue can render an "encrypted" / "plaintext"
      // badge per row. True iff the row has a `v1:` blob (we trust the prefix
      // rather than test STORAGE_KEY validity here — list shouldn't perform
      // crypto on the hot path).
      encrypted: String(isEncryptedPassword(s.password_encrypted)),
      // 089 S2 — 'library' | 'sync_only'
      mode: s.mode ?? "library",
    },
  }));
  return c.text(subsonicOK({ storageSources: { source: sources } }), 200, XML);
});

sourcesRoutes.post("/sources/add", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    type: string; base_url: string; name?: string; username?: string;
    password?: string; root_path?: string; mode?: string;
  }>();
  if (!body.type || !body.base_url) {
    return c.text(subsonicError(0, "Missing type or base_url"), 400, XML);
  }
  // 089 S2 — validate mode
  const mode = body.mode ?? "library";
  if (mode !== "library" && mode !== "sync_only") {
    return c.text(subsonicError(0, "Invalid mode: must be 'library' or 'sync_only'"), 400, XML);
  }
  const db = c.env.DB;
  const id = crypto.randomUUID().substring(0, 8);
  const now = Math.floor(Date.now() / 1000);
  const plaintext = body.password ?? "";
  const { password_encrypted, password } = await preparePasswordWrite(plaintext, c.env);
  await db.prepare(
    `INSERT INTO storage_sources
       (id, type, name, base_url, username, password, password_encrypted, root_path, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body.type, body.name || "", body.base_url, body.username || null,
    // Don't INSERT NULL for password since the legacy column is NOT NULL on some
    // older deployments — empty string is the safe sentinel.
    password, password_encrypted, body.root_path || "", mode, now, now,
  ).run();
  return c.text(subsonicOK({}), 200, XML);
});

sourcesRoutes.post("/sources/update", permissionMiddleware("manage_sources"), async (c) => {
  const body = await c.req.json<{
    id: string; name?: string; base_url?: string; username?: string; password?: string;
    root_path?: string; enabled?: number; mode?: string;
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
    // 068 — Always rewrite BOTH columns so an admin rotating a password from a
    // legacy row also clears the old plaintext. preparePasswordWrite enforces
    // the STORAGE_KEY-set / STORAGE_KEY-missing branches.
    const { password_encrypted, password } = await preparePasswordWrite(body.password, c.env);
    sets.push("password = ?");
    binds.push(password);
    sets.push("password_encrypted = ?");
    binds.push(password_encrypted);
  }
  if (body.root_path !== undefined) { sets.push("root_path = ?"); binds.push(body.root_path); }
  if (body.enabled !== undefined) { sets.push("enabled = ?"); binds.push(body.enabled ? 1 : 0); }
  // 089 S2 — update mode
  if (body.mode !== undefined) { sets.push("mode = ?"); binds.push(body.mode); }
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

// 068 — Bulk-encrypt every remaining plaintext row.
//
// Eligibility: rows with password_encrypted IS NULL AND password IS NOT NULL
// AND password <> ''. r2 / url sources typically have NULL password so they
// fall out of the WHERE clause automatically.
//
// Guards:
//   • super-admin only (manage_sources middleware + user.level >= 3) — this is
//     a one-way operation, regular admins shouldn't be able to trigger it.
//   • STORAGE_KEY must be set, otherwise the migration would be a no-op or
//     worse (writing a fake `v1:` blob with the fallback key, which we don't
//     even support).
//
// Response is JSON `{ ok, migrated, failed, total, error? }` because the rest
// of the /storage bucket already uses JSON for non-XML actions. Sources.vue
// can branch on `ok` directly.
sourcesRoutes.post(
  "/sources/migratePasswords",
  permissionMiddleware("manage_sources"),
  async (c) => {
    // 087 — the previous redundant `user.level < 3` check was removed. The
    // manage_sources permission middleware (above) is the canonical gate; an
    // operator who has been granted manage_sources is by definition allowed
    // to migrate passwords.
    const env = c.env;
    if (!env.STORAGE_KEY || env.STORAGE_KEY.length === 0) {
      return c.json({ ok: false, error: "STORAGE_KEY not configured" }, 400);
    }

    const db = env.DB;
    const rows = (await db
      .prepare(
        `SELECT id, password FROM storage_sources
         WHERE password_encrypted IS NULL
           AND password IS NOT NULL
           AND password <> ''`,
      )
      .all<{ id: string; password: string }>()).results;

    let migrated = 0;
    let failed = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      try {
        const blob = await encryptPassword(row.password, env.STORAGE_KEY);
        // Atomically swap: write the encrypted blob, blank the legacy column,
        // bump updated_at so the audit log shows the rewrite.
        await db
          .prepare(
            `UPDATE storage_sources
             SET password_encrypted = ?, password = '', updated_at = ?
             WHERE id = ?`,
          )
          .bind(blob, now, row.id)
          .run();
        migrated++;
      } catch (e) {
        failed++;
        console.error(`migratePasswords id=${row.id} failed:`, e);
      }
    }
    return c.json({ ok: true, migrated, failed, total: rows.length });
  },
);
