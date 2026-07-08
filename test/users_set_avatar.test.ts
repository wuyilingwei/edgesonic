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

// 064 — POST /edgesonic/users/setAvatar tests.
// 072 — Extended with list/get JSON-shape assertions after the bucket-wide
// XML→JSON conversion (XML envelope removed, all 5 CRUD endpoints now emit
// `{ ok: true, ... }` / `{ ok: false, error }`).
//
// Coverage:
//   • happy path: caller=self, png/jpg → R2.put called + UPDATE users.avatar_r2_key
//   • mime guard: rejects image/webp (and anything outside jpeg/png)
//   • size guard: rejects >500KB after base64 decode
//   • auth: non-self caller with level<2 → 403
//   • auth: admin (level=2) editing another user → success
//   • base64 with data:URL prefix is tolerated
//   • [072] list returns { ok, users: [...] } JSON
//   • [072] get returns { ok, user } JSON; missing user → 404 JSON {ok:false,error}
//
// Run: npx tsx test/users_set_avatar.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { usersRoutes } from "../worker/src/endpoints/edgesonic/users";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim backed by node:sqlite (same pattern as batch_write_tags.test.ts)
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boundArgs: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = unknown>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: any }> {
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare };
}

// ---------------------------------------------------------------------------
// R2 spy — records every put() with key, bytes, contentType.
// ---------------------------------------------------------------------------
interface R2PutCall {
  key: string;
  size: number;
  contentType?: string;
  body: Uint8Array;
}
function makeR2Spy() {
  const calls: R2PutCall[] = [];
  return {
    calls,
    bucket: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async put(key: string, body: any, opts?: { httpMetadata?: { contentType?: string } }) {
        let bytes: Uint8Array;
        if (body instanceof Uint8Array) bytes = body;
        else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
        else bytes = new Uint8Array(0);
        calls.push({
          key,
          size: bytes.length,
          contentType: opts?.httpMetadata?.contentType,
          body: bytes,
        });
        return {};
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Schema + seed
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      avatar_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    INSERT INTO users (username, master_password, level) VALUES ('alice', 'x', 1);
    INSERT INTO users (username, master_password, level) VALUES ('bob',   'x', 1);
    INSERT INTO users (username, master_password, level) VALUES ('admin', 'x', 2);
    INSERT INTO users (username, master_password, level) VALUES ('root',  'x', 3);

    -- 072 — list/create/update/delete go through permissionMiddleware('manage_users'),
    -- which reads from user_permissions. Seed the rows the middleware expects.
    -- Level 2 (admin) and 3 (root) get manage_users enabled with no rph cap.
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_rph INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES (2, 'manage_users', 1, 0);
    INSERT INTO user_permissions (level, permission, enabled, max_rph) VALUES (3, 'manage_users', 1, 0);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Hono harness — injects session user. permissionMiddleware NOT engaged because
// setAvatar does not use it (the route does its own self-OR-admin check).
// ---------------------------------------------------------------------------
function makeApp(
  sqlite: DatabaseSync,
  caller: { username: string; level: number },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: caller.username, level: caller.level, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/edgesonic", usersRoutes);
  const r2 = makeR2Spy();
  const env = { DB: makeD1(sqlite), MUSIC_BUCKET: r2.bucket };
  return {
    r2,
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
    async get(url: string) {
      const req = new Request(`http://test${url}`, { method: "GET" });
      return app.fetch(req, env);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers: produce a base64 payload of a given byte length.
// ---------------------------------------------------------------------------
function makeBase64(bytes: number, fill = 0x41): string {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = fill;
  // Encode without Buffer to mirror the Workers runtime path; use btoa-ish.
  // Node's Buffer is available in tsx, so simpler:
  return Buffer.from(buf).toString("base64");
}

// A minimal 1x1 PNG (89 50 4E 47 ...). Real PNG so the bytes are recognisable
// in spy assertions.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
async function main() {
console.log("\nhappy path: self uploads PNG:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/png",
  });
  assert(r.status === 200, `200 status (got ${r.status})`);
  const body = await r.json() as { ok: boolean; avatarKey: string };
  assert(body.ok === true, "body.ok true");
  assert(body.avatarKey === "avatars/alice.png", `avatarKey=avatars/alice.png (got ${body.avatarKey})`);

  assert(r2.calls.length === 1, `R2.put called once (got ${r2.calls.length})`);
  assert(r2.calls[0].key === "avatars/alice.png", "R2 key correct");
  assert(r2.calls[0].contentType === "image/png", "R2 contentType=image/png");
  assert(r2.calls[0].size > 0 && r2.calls[0].size < 200, "R2 body size is the tiny PNG");

  const row = sqlite.prepare("SELECT avatar_r2_key, updated_at FROM users WHERE username='alice'").get() as {
    avatar_r2_key: string; updated_at: number;
  };
  assert(row.avatar_r2_key === "avatars/alice.png", "D1 avatar_r2_key persisted");
  assert(row.updated_at > 0, "updated_at bumped");
}

console.log("\nhappy path: self uploads JPEG (data: URL prefix tolerated):");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: "data:image/jpeg;base64," + makeBase64(1024, 0xff),
    mimeType: "image/jpeg",
  });
  assert(r.status === 200, `200 (got ${r.status})`);
  assert(r2.calls.length === 1, "R2.put called once");
  assert(r2.calls[0].key === "avatars/alice.jpg", "R2 key extension=jpg");
  assert(r2.calls[0].contentType === "image/jpeg", "R2 contentType=image/jpeg");
  assert(r2.calls[0].size === 1024, `R2 body size=1024 (got ${r2.calls[0].size})`);
}

console.log("\nadmin can edit another user's avatar:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "admin", level: 2 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "bob",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/png",
  });
  assert(r.status === 200, `200 (got ${r.status})`);
  assert(r2.calls.length === 1, "R2.put called");
  assert(r2.calls[0].key === "avatars/bob.png", "R2 key targets bob");
  const row = sqlite.prepare("SELECT avatar_r2_key FROM users WHERE username='bob'").get() as {
    avatar_r2_key: string;
  };
  assert(row.avatar_r2_key === "avatars/bob.png", "bob's avatar_r2_key set");
}

console.log("\nauth: regular user trying to edit another user → 403:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "bob",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/png",
  });
  assert(r.status === 403, `403 (got ${r.status})`);
  assert(r2.calls.length === 0, "R2.put NOT called");
  const row = sqlite.prepare("SELECT avatar_r2_key FROM users WHERE username='bob'").get() as {
    avatar_r2_key: string | null;
  };
  assert(row.avatar_r2_key === null, "bob's avatar unchanged");
}

console.log("\nmime guard: rejects image/webp:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/webp",
  });
  assert(r.status === 400, `400 (got ${r.status})`);
  const body = await r.json() as { ok: boolean; error: string };
  assert(body.ok === false, "ok=false");
  assert(/mime/i.test(body.error), `error mentions mime (got: ${body.error})`);
  assert(r2.calls.length === 0, "R2.put NOT called");
}

console.log("\nmime guard: rejects text/plain:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "text/plain",
  });
  assert(r.status === 400, `400 (got ${r.status})`);
  assert(r2.calls.length === 0, "R2.put NOT called");
}

console.log("\nsize guard: rejects >500KB payload:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const bigBytes = 500 * 1024 + 1; // 1 byte over
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: makeBase64(bigBytes),
    mimeType: "image/jpeg",
  });
  assert(r.status === 400, `400 (got ${r.status})`);
  const body = await r.json() as { ok: boolean; error: string };
  assert(/too large/i.test(body.error), `error mentions too large (got: ${body.error})`);
  assert(r2.calls.length === 0, "R2.put NOT called for oversized");
}

console.log("\nsize guard: accepts exactly 500KB:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: makeBase64(500 * 1024),
    mimeType: "image/jpeg",
  });
  assert(r.status === 200, `200 (got ${r.status})`);
  assert(r2.calls.length === 1, "R2.put called");
  assert(r2.calls[0].size === 500 * 1024, "exactly 500KB");
}

console.log("\nempty payload → 400:");
{
  const sqlite = buildDb();
  const { post, r2 } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "alice",
    imageBase64: "",
    mimeType: "image/jpeg",
  });
  assert(r.status === 400, `400 (got ${r.status})`);
  assert(r2.calls.length === 0, "R2.put NOT called");
}

console.log("\nmissing username → 400:");
{
  const sqlite = buildDb();
  const { post } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await post("/edgesonic/users/setAvatar", {
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/png",
  });
  assert(r.status === 400, `400 (got ${r.status})`);
}

console.log("\nunknown target user → 404:");
{
  const sqlite = buildDb();
  // super admin caller so we'd otherwise pass auth — only the lookup should fail
  const { post, r2 } = makeApp(sqlite, { username: "root", level: 3 });
  const r = await post("/edgesonic/users/setAvatar", {
    username: "ghost",
    imageBase64: TINY_PNG_BASE64,
    mimeType: "image/png",
  });
  assert(r.status === 404, `404 (got ${r.status})`);
  assert(r2.calls.length === 0, "R2.put NOT called for unknown user");
}

// ---------------------------------------------------------------------------
// 072 — list / get JSON shape
// ---------------------------------------------------------------------------

console.log("\n[072] users/list returns JSON {ok, users}:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite, { username: "root", level: 3 });
  const r = await get("/edgesonic/users/list");
  assert(r.status === 200, `200 (got ${r.status})`);
  const ct = r.headers.get("content-type") || "";
  assert(/application\/json/.test(ct), `content-type is json (got: ${ct})`);
  const body = await r.json() as { ok: boolean; users: Array<{ username: string; level: number; enabled: boolean }> };
  assert(body.ok === true, "ok=true");
  assert(Array.isArray(body.users), "users is array");
  assert(body.users.length === 4, `4 seeded users (got ${body.users.length})`);
  const root = body.users.find((u) => u.username === "root");
  assert(!!root, "root present");
  assert(root?.level === 3, `root.level=3 (got ${root?.level})`);
  assert(root?.enabled === true, `root.enabled=true (got ${root?.enabled})`);
  // ensure no XML leaked into the body
  const rawText = JSON.stringify(body);
  assert(!/<subsonic-response/.test(rawText), "no XML envelope in JSON body");
}

console.log("\n[072] users/get returns JSON {ok, user}:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await get("/edgesonic/users/get?username=alice");
  assert(r.status === 200, `200 (got ${r.status})`);
  const body = await r.json() as { ok: boolean; user: { username: string; level: number; enabled: boolean } };
  assert(body.ok === true, "ok=true");
  assert(body.user?.username === "alice", `user.username=alice (got ${body.user?.username})`);
  assert(body.user?.level === 1, `user.level=1 (got ${body.user?.level})`);
  assert(body.user?.enabled === true, `user.enabled=true (got ${body.user?.enabled})`);
}

console.log("\n[072] users/get unknown user → 404 JSON {ok:false,error}:");
{
  const sqlite = buildDb();
  const { get } = makeApp(sqlite, { username: "alice", level: 1 });
  const r = await get("/edgesonic/users/get?username=ghost");
  assert(r.status === 404, `404 (got ${r.status})`);
  const body = await r.json() as { ok: boolean; error: string };
  assert(body.ok === false, "ok=false");
  assert(/not found/i.test(body.error), `error mentions 'not found' (got: ${body.error})`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
}

main();
