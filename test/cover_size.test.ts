//
// Strategy:
//   * In-memory SQLite D1 shim with an `albums` row pre-baked.
//   * R2 + KV map-backed shims that track every get/put so we can assert
//     the sized-vs-original cache split.
//   * Hono harness mounts mediaRoutes directly (no auth wrapper — getCoverArt
//     is guest-allowed in auth.ts anyway).
//
// Coverage:
//   1. size=128 + R2 miss → bytes copied to covers/<id>_s128 → 200 with X-EdgeSonic-Cover-Cache: miss
//   2. size=128 + R2 hit  → original key never touched, header reports hit
//   3. no size param      → legacy path serves covers/<id>
//   4. size=999 (not in allowlist) → treated as no size (legacy path)
//   5. legacy path with no `cover_r2_key` and no on-demand source → 404
//
// Run: npx tsx test/cover_size.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../worker/src/endpoints/subsonic/media";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (s: unknown[]) => Promise.all(s.map((x: unknown) => (x as { run: () => Promise<unknown> }).run())) };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      year INTEGER,
      genre TEXT,
      cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      image_r2_key TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );

    INSERT INTO albums (id, name, cover_r2_key) VALUES ('al-x', '25', 'covers/al-x');
    INSERT INTO albums (id, name, cover_r2_key) VALUES ('al-none', 'Orphan', NULL);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// R2 shim — Map<key, { data: Uint8Array; contentType: string }>.
// ---------------------------------------------------------------------------
interface R2Entry { data: Uint8Array; contentType: string; }
type Counter = { get: string[]; put: string[]; head: string[]; };

function makeR2(initial: Record<string, R2Entry>, counter: Counter) {
  const map = new Map<string, R2Entry>(Object.entries(initial));
  return {
    async get(key: string) {
      counter.get.push(key);
      const v = map.get(key);
      if (!v) return null;
      return {
        async arrayBuffer() { return v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.byteLength); },
        get body() {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(v.data);
              controller.close();
            },
          });
        },
        writeHttpMetadata(h: Headers) { h.set("Content-Type", v.contentType); },
        size: v.data.length,
      };
    },
    async put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: { httpMetadata?: { contentType?: string } }) {
      counter.put.push(key);
      const ct = opts?.httpMetadata?.contentType || "application/octet-stream";
      // We only ever pass Uint8Array in this endpoint
      const buf = body instanceof Uint8Array ? body : new Uint8Array(0);
      map.set(key, { data: buf, contentType: ct });
    },
    async head(key: string) {
      counter.head.push(key);
      const v = map.get(key);
      return v ? { size: v.data.length } : null;
    },
    _map: map,
  };
}

function makeKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  };
}

// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, r2: ReturnType<typeof makeR2>, kv: ReturnType<typeof makeKV>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any }>();
  app.route("/rest", mediaRoutes);
  const env = {
    DB: makeD1(sqlite),
    MUSIC_BUCKET: r2,
    KV: kv,
  };
  return {
    async get(url: string) {
      const req = new Request(`http://test${url}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

// Pre-bake a single original cover
function seedCover(): { counter: Counter; r2: ReturnType<typeof makeR2>; kv: ReturnType<typeof makeKV> } {
  const counter: Counter = { get: [], put: [], head: [] };
  const r2 = makeR2({
    "covers/al-x": {
      data: new TextEncoder().encode("ORIGINAL_JPEG_BYTES_marker"),
      contentType: "image/jpeg",
    },
  }, counter);
  const kv = makeKV();
  return { counter, r2, kv };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("size=128 + R2 miss → copies original to sized key + serves miss:");
  {
    const { counter, r2, kv } = seedCover();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-x&size=128");
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === "128", "size echo header");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === "miss", "cache miss header");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert(new TextDecoder().decode(bytes).includes("ORIGINAL_JPEG_BYTES_marker"), "serves original bytes");
    assert(counter.put.includes("covers/al-x_s128"), "wrote sized cache key");
    assert(r2._map.has("covers/al-x_s128"), "sized key persisted in R2");
    assert(r.headers.get("Content-Type") === "image/jpeg", "Content-Type preserved");
  }

  console.log("\nsize=128 + R2 hit → does NOT touch original key:");
  {
    const counter: Counter = { get: [], put: [], head: [] };
    const r2 = makeR2({
      "covers/al-x": { data: new TextEncoder().encode("ORIGINAL"), contentType: "image/jpeg" },
      "covers/al-x_s128": { data: new TextEncoder().encode("SIZED_128"), contentType: "image/jpeg" },
    }, counter);
    const kv = makeKV();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-x&size=128");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === "hit", "cache hit header");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert(new TextDecoder().decode(bytes) === "SIZED_128", "serves sized bytes (not original)");
    assert(!counter.get.includes("covers/al-x"), "original key never read on hit");
    assert(counter.put.length === 0, "no put on hit");
  }

  console.log("\nno size param → legacy path hits original key only:");
  {
    const { counter, r2, kv } = seedCover();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-x");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === null, "no size header on legacy path");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === null, "no cache header on legacy path");
    assert(counter.get.includes("covers/al-x"), "legacy path reads original key");
    assert(counter.put.length === 0, "legacy path never writes");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert(new TextDecoder().decode(bytes).includes("ORIGINAL_JPEG_BYTES_marker"), "legacy serves original bytes");
  }

  console.log("\nsize=999 (not in allowlist) → treated as no size:");
  {
    const { counter, r2, kv } = seedCover();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-x&size=999");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === null, "no size header for invalid size");
    // legacy path reads ONLY covers/al-x; never reads or writes a sized variant
    assert(!counter.get.some((k) => k.includes("_s")), "never reads any sized variant");
    assert(counter.put.length === 0, "no put");
  }

  console.log("\nlegacy path 404 when album has no cover key and KV negative-cached:");
  {
    const counter: Counter = { get: [], put: [], head: [] };
    const r2 = makeR2({}, counter);
    const kv = makeKV();
    await kv.put("nocover:al-none", "1");
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    const r = await get("/rest/getCoverArt?id=al-none");
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  console.log("\nsize=64 → covers/<id>_s64 (separate cache key from 128):");
  {
    const { counter, r2, kv } = seedCover();
    const sqlite = buildDb();
    const { get } = makeApp(sqlite, r2, kv);
    await get("/rest/getCoverArt?id=al-x&size=64");
    await get("/rest/getCoverArt?id=al-x&size=128");
    assert(counter.put.includes("covers/al-x_s64"), "64-sized key written");
    assert(counter.put.includes("covers/al-x_s128"), "128-sized key written");
    assert(r2._map.has("covers/al-x_s64") && r2._map.has("covers/al-x_s128"), "both sized keys persisted");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
