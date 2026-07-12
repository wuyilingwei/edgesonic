// POST /storage/files/moveFolder + /storage/files/deleteFolder tests.
//
// Covers:
//  • moveFolder: re-homes every object under the prefix (incl. the mkdir
//    ".keep" marker), preserves httpMetadata, rewrites song_instances
//    storage_uri rows, paginates past R2's 1000-key page limit
//  • moveFolder: rejects moving a folder into itself / a descendant (400)
//  • moveFolder: rejects empty / ".." traversal paths (400)
//  • moveFolder: unknown (empty) folder → 404
//  • moveFolder (single-file /files/move): dest === key is a no-op success
//    and does NOT delete the object
//  • deleteFolder: removes every object under the prefix page by page,
//    cascades song_instances rows and orphan masters, leaves siblings alone
//  • deleteFolder: LIKE-wildcard folder names ("a_b") don't over-match
//    sibling instances ("aXb")
//  • deleteFolder: invalid path → 400, empty folder → 404
//
// Adapters are shimmed via an in-memory R2 bucket + minimal D1 mock so no
// real network calls are made (same pattern as files_mkdir.test.ts).
//
// Run: npx tsx test/internal/files_folder_ops.test.ts

import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

declare global {
  type D1Database = unknown;
  type D1PreparedStatement = unknown;
  type Env = unknown;
}

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// In-memory R2 bucket shim — list() honours prefix + cursor + limit so the
// pagination loops in moveFolder/deleteFolder get exercised for real.
// ---------------------------------------------------------------------------
interface R2Item { key: string; body: Uint8Array; contentType: string }

function makeR2Bucket(pageLimit = 1000) {
  const store = new Map<string, R2Item>();
  return {
    store,
    async put(key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      let buf: Uint8Array;
      if (body instanceof ArrayBuffer) buf = new Uint8Array(body);
      else if (body instanceof Uint8Array) buf = body;
      else buf = new Uint8Array(0);
      store.set(key, { key, body: buf, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return { key, body: item.body, httpMetadata: { contentType: item.contentType }, customMetadata: {} };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list({ prefix, cursor, limit }: { prefix?: string; cursor?: string; limit?: number }) {
      // Like real R2, the cursor is a resume token anchored to the last key
      // returned (not an index) — deleting already-listed objects between
      // pages must not shift the continuation point.
      const cap = Math.min(limit ?? 1000, pageLimit);
      const all = Array.from(store.keys()).filter((k) => k.startsWith(prefix || "")).sort();
      const remaining = cursor ? all.filter((k) => k > cursor) : all;
      const page = remaining.slice(0, cap);
      const truncated = page.length < remaining.length;
      return {
        objects: page.map((k) => {
          const item = store.get(k)!;
          return { key: k, size: item.body.length, httpMetadata: { contentType: item.contentType }, customMetadata: {} };
        }),
        delimitedPrefixes: [] as string[],
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// D1 shim — in-memory song_instances/song_masters tables, supporting exactly
// the statements the files endpoints issue (incl. LIKE ... ESCAPE '\').
// ---------------------------------------------------------------------------
interface InstanceRow { id: string; master_id: string; storage_uri: string }
interface MasterRow { id: string; album_id: string; artist_id: string }

function likeToRegExp(pattern: string): RegExp {
  // Translate a SQL LIKE pattern with ESCAPE '\' into a RegExp.
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (ch === "%") { out += ".*"; continue; }
    if (ch === "_") { out += "."; continue; }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function makeD1(instances: InstanceRow[], masters: MasterRow[]) {
  const db = {
    instances,
    masters,
    prepare(sql: string) {
      const stmt = {
        sql: sql.trim().replace(/\s+/g, " "),
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        async first<T = unknown>(): Promise<T | null> {
          if (stmt.sql.includes("FROM user_permissions")) return { enabled: 1, max_rph: 0 } as T;
          if (stmt.sql.includes("SELECT master_id FROM song_instances WHERE storage_uri = ?")) {
            const row = instances.find((r) => r.storage_uri === stmt.args[0]);
            return (row ? { master_id: row.master_id } : null) as T | null;
          }
          if (stmt.sql.includes("SELECT COUNT(*) AS n FROM song_instances WHERE master_id = ?")) {
            return { n: instances.filter((r) => r.master_id === stmt.args[0]).length } as T;
          }
          if (stmt.sql.includes("SELECT album_id, artist_id FROM song_masters WHERE id = ?")) {
            const m = masters.find((r) => r.id === stmt.args[0]);
            return (m ? { album_id: m.album_id, artist_id: m.artist_id } : null) as T | null;
          }
          return null;
        },
        async all<T = unknown>() {
          if (stmt.sql.includes("SELECT DISTINCT master_id FROM song_instances WHERE storage_uri LIKE ?")) {
            const re = likeToRegExp(stmt.args[0] as string);
            const ids = Array.from(new Set(instances.filter((r) => re.test(r.storage_uri)).map((r) => r.master_id)));
            return { results: ids.map((id) => ({ master_id: id })) as T[], success: true as const, meta: {} };
          }
          return { results: [] as T[], success: true as const, meta: {} };
        },
        async run() {
          if (stmt.sql.includes("UPDATE song_instances SET storage_uri = ?")) {
            const [newUri, , oldUri] = stmt.args as [string, number, string];
            for (const r of instances) if (r.storage_uri === oldUri) r.storage_uri = newUri;
          } else if (stmt.sql.includes("DELETE FROM song_instances WHERE storage_uri LIKE ?")) {
            const re = likeToRegExp(stmt.args[0] as string);
            for (let i = instances.length - 1; i >= 0; i--) if (re.test(instances[i].storage_uri)) instances.splice(i, 1);
          } else if (stmt.sql.includes("DELETE FROM song_instances WHERE storage_uri = ?")) {
            const idx = instances.findIndex((r) => r.storage_uri === stmt.args[0]);
            if (idx >= 0) instances.splice(idx, 1);
          } else if (stmt.sql.includes("DELETE FROM song_masters WHERE id = ?")) {
            const idx = masters.findIndex((r) => r.id === stmt.args[0]);
            if (idx >= 0) masters.splice(idx, 1);
          }
          return { success: true as const, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const out = [] as unknown[];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// Hono app harness
// ---------------------------------------------------------------------------
function makeApp(bucket: ReturnType<typeof makeR2Bucket>, db: ReturnType<typeof makeD1>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", filesRoutes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = { DB: db, MUSIC_BUCKET: bucket };

  return {
    async post(url: string, body: unknown) {
      const req = new Request(`http://test${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return app.fetch(req, env);
    },
  };
}

async function main() {
  // ── moveFolder: recursive move with .keep, metadata, D1 rewrite ──────────
  console.log("\nmoveFolder → moves every object incl. .keep, rewrites storage_uri:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/a/.keep", new Uint8Array(0), { httpMetadata: { contentType: "application/x-directory" } });
    await bucket.put("music/a/t1.mp3", new Uint8Array([1]), { httpMetadata: { contentType: "audio/mpeg" } });
    await bucket.put("music/a/sub/t2.flac", new Uint8Array([2]), { httpMetadata: { contentType: "audio/flac" } });
    await bucket.put("music/aa/other.mp3", new Uint8Array([3]), { httpMetadata: { contentType: "audio/mpeg" } });
    const db = makeD1(
      [
        { id: "i1", master_id: "m1", storage_uri: "r2://music/a/t1.mp3" },
        { id: "i2", master_id: "m2", storage_uri: "r2://music/a/sub/t2.flac" },
        { id: "i3", master_id: "m3", storage_uri: "r2://music/aa/other.mp3" },
      ],
      [],
    );
    const app = makeApp(bucket, db);
    const r = await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/b/a" });
    assert(r.status === 200, `200 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; moved: number }>();
    assert(j.ok && j.moved === 3, `moved=3 (got ${j.moved})`);
    assert(bucket.store.has("music/b/a/.keep"), ".keep marker travelled along");
    assert(bucket.store.has("music/b/a/t1.mp3") && bucket.store.has("music/b/a/sub/t2.flac"), "nested objects re-homed");
    assert(!Array.from(bucket.store.keys()).some((k) => k.startsWith("music/a/")), "source prefix emptied");
    assert(bucket.store.has("music/aa/other.mp3"), "sibling prefix 'music/aa' untouched (no prefix over-match)");
    assert(bucket.store.get("music/b/a/t1.mp3")?.contentType === "audio/mpeg", "httpMetadata preserved");
    assert(db.instances.find((i) => i.id === "i1")?.storage_uri === "r2://music/b/a/t1.mp3", "i1 storage_uri rewritten");
    assert(db.instances.find((i) => i.id === "i2")?.storage_uri === "r2://music/b/a/sub/t2.flac", "i2 storage_uri rewritten");
    assert(db.instances.find((i) => i.id === "i3")?.storage_uri === "r2://music/aa/other.mp3", "i3 (sibling) untouched");
  }

  // ── moveFolder: pagination past the page limit ────────────────────────────
  console.log("\nmoveFolder → paginates (page limit 2, 5 objects):");
  {
    const bucket = makeR2Bucket(2);
    for (let i = 0; i < 5; i++) await bucket.put(`music/big/f${i}.mp3`, new Uint8Array([i]), { httpMetadata: { contentType: "audio/mpeg" } });
    const db = makeD1([], []);
    const app = makeApp(bucket, db);
    const r = await app.post("/storage/files/moveFolder", { path: "music/big", dest: "music/moved" });
    const j = await r.json<{ ok: boolean; moved: number }>();
    assert(j.ok && j.moved === 5, `moved=5 across pages (got ${j.moved})`);
    assert(!Array.from(bucket.store.keys()).some((k) => k.startsWith("music/big/")), "source emptied across pages");
    assert(Array.from(bucket.store.keys()).filter((k) => k.startsWith("music/moved/")).length === 5, "all 5 objects at dest");
  }

  // ── moveFolder: into itself / descendant → 400 ───────────────────────────
  console.log("\nmoveFolder → refuses self/descendant destinations:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/a/t1.mp3", new Uint8Array([1]));
    const app = makeApp(bucket, makeD1([], []));
    const r1 = await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/a" });
    assert(r1.status === 400, `dest === path → 400 (got ${r1.status})`);
    const r2 = await app.post("/storage/files/moveFolder", { path: "music/a", dest: "music/a/inner" });
    assert(r2.status === 400, `dest inside path → 400 (got ${r2.status})`);
    assert(bucket.store.has("music/a/t1.mp3"), "nothing was moved or deleted");
  }

  // ── moveFolder: invalid paths → 400, missing folder → 404 ────────────────
  console.log("\nmoveFolder → path validation:");
  {
    const app = makeApp(makeR2Bucket(), makeD1([], []));
    assert((await app.post("/storage/files/moveFolder", { path: "", dest: "music/x" })).status === 400, "empty path → 400");
    assert((await app.post("/storage/files/moveFolder", { path: "music/../x", dest: "music/y" })).status === 400, "'..' segment → 400");
    assert((await app.post("/storage/files/moveFolder", { path: "music/a", dest: "../y" })).status === 400, "'..' dest → 400");
    assert((await app.post("/storage/files/moveFolder", { path: "music/nope", dest: "music/x" })).status === 404, "empty/unknown folder → 404");
  }

  // ── files/move: dest === key no-op keeps the object ──────────────────────
  console.log("\nfiles/move → same-key move is a no-op, not a delete:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/t.mp3", new Uint8Array([9]), { httpMetadata: { contentType: "audio/mpeg" } });
    const app = makeApp(bucket, makeD1([], []));
    const r = await app.post("/storage/files/move", { key: "music/t.mp3", dest: "music/t.mp3" });
    const j = await r.json<{ ok: boolean }>();
    assert(j.ok, "ok=true");
    assert(bucket.store.has("music/t.mp3"), "object still exists after self-move");
  }

  // ── deleteFolder: recursive delete + D1 cascade ───────────────────────────
  console.log("\ndeleteFolder → deletes prefix recursively, cascades D1:");
  {
    const bucket = makeR2Bucket(2); // small pages → exercise pagination too
    await bucket.put("music/kill/.keep", new Uint8Array(0));
    await bucket.put("music/kill/t1.mp3", new Uint8Array([1]));
    await bucket.put("music/kill/sub/t2.mp3", new Uint8Array([2]));
    await bucket.put("music/keep/t3.mp3", new Uint8Array([3]));
    const db = makeD1(
      [
        { id: "i1", master_id: "m1", storage_uri: "r2://music/kill/t1.mp3" },
        { id: "i2", master_id: "m2", storage_uri: "r2://music/kill/sub/t2.mp3" },
        { id: "i2b", master_id: "m2", storage_uri: "r2://music/keep/t3.mp3" }, // m2 has a survivor
      ],
      [
        { id: "m1", album_id: "al1", artist_id: "ar1" },
        { id: "m2", album_id: "al2", artist_id: "ar2" },
      ],
    );
    const app = makeApp(bucket, db);
    const r = await app.post("/storage/files/deleteFolder", { path: "music/kill" });
    assert(r.status === 200, `200 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; deleted: number }>();
    assert(j.ok && j.deleted === 3, `deleted=3 (got ${j.deleted})`);
    assert(!Array.from(bucket.store.keys()).some((k) => k.startsWith("music/kill/")), "prefix emptied");
    assert(bucket.store.has("music/keep/t3.mp3"), "sibling folder untouched");
    assert(!db.instances.some((i) => i.id === "i1" || i.id === "i2"), "instances under prefix removed");
    assert(db.instances.some((i) => i.id === "i2b"), "surviving instance kept");
    assert(!db.masters.some((m) => m.id === "m1"), "orphaned master m1 removed");
    assert(db.masters.some((m) => m.id === "m2"), "master m2 kept (still has an instance)");
  }

  // ── deleteFolder: SQL wildcard folder name doesn't over-match ────────────
  console.log("\ndeleteFolder → LIKE wildcards in folder names are escaped:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/a_b/t1.mp3", new Uint8Array([1]));
    const db = makeD1(
      [
        { id: "i1", master_id: "m1", storage_uri: "r2://music/a_b/t1.mp3" },
        { id: "i2", master_id: "m2", storage_uri: "r2://music/aXb/t1.mp3" }, // would match unescaped '_'
      ],
      [],
    );
    const app = makeApp(bucket, db);
    const r = await app.post("/storage/files/deleteFolder", { path: "music/a_b" });
    const j = await r.json<{ ok: boolean }>();
    assert(j.ok, "ok=true");
    assert(!db.instances.some((i) => i.id === "i1"), "exact-folder instance removed");
    assert(db.instances.some((i) => i.id === "i2"), "wildcard-lookalike sibling instance kept");
  }

  // ── deleteFolder: invalid / missing ───────────────────────────────────────
  console.log("\ndeleteFolder → path validation:");
  {
    const app = makeApp(makeR2Bucket(), makeD1([], []));
    assert((await app.post("/storage/files/deleteFolder", { path: "" })).status === 400, "empty path → 400");
    assert((await app.post("/storage/files/deleteFolder", { path: "music/../x" })).status === 400, "'..' segment → 400");
    assert((await app.post("/storage/files/deleteFolder", { path: "music/nothing" })).status === 404, "unknown folder → 404");
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
