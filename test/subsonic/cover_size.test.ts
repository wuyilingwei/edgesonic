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

//
// Strategy:
//  * In-memory SQLite D1 shim with an `albums` row pre-baked.
//  * R2 + KV map-backed shims that track every get/put so we can assert
//   the sized-vs-original cache split.
//  * A fake IMAGES binding that "resizes" by emitting `RESIZED:<format>` so we
//   can assert the transform ran and which format was negotiated.
//  * Hono harness mounts mediaRoutes directly (no auth wrapper — getCoverArt
//   is guest-allowed in auth.ts anyway).
//
// Coverage:
//  1. size + miss → transform once → cache covers/<id>_s<size>.<ext> → miss
//  2. size + hit  → sized slot served, original + transform untouched
//  3. no size     → legacy path serves the full original
//  4. size=999    → snaps up to 512 (nearest bucket), not rejected
//  5. no cover    → 404
//  6. Accept negotiation → webp/avif slots; */* and none default to jpeg
//  7. IMAGES unavailable → bypass: original bytes, no sized write, no 500
//
// Run: npx tsx test/subsonic/cover_size.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mediaRoutes } from "../../worker/src/endpoints/subsonic/media";

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

// Fake IMAGES binding: records the format it was asked for and emits a
// deterministic `RESIZED:<format>` payload so tests can assert the transform
// ran and which format won negotiation.
function makeImages(counter: { transforms: string[] }) {
  const transformer = (fmt: { value: string }) => ({
    transform() { return transformer(fmt); },
    async output(opts: { format: string }) {
      fmt.value = opts.format;
      counter.transforms.push(opts.format);
      const bytes = new TextEncoder().encode(`RESIZED:${opts.format}`);
      return {
        response() { return new Response(bytes, { headers: { "Content-Type": opts.format } }); },
        contentType() { return opts.format; },
        image() { return new Response(bytes).body!; },
      };
    },
  });
  return {
    input(stream: ReadableStream<Uint8Array>) {
      void stream; // consumed by the real binding; the fake ignores the bytes
      return transformer({ value: "" });
    },
  };
}

// ---------------------------------------------------------------------------
function makeApp(
  sqlite: DatabaseSync,
  r2: ReturnType<typeof makeR2>,
  kv: ReturnType<typeof makeKV>,
  images?: ReturnType<typeof makeImages>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any }>();
  app.route("/rest", mediaRoutes);
  const env = {
    DB: makeD1(sqlite),
    MUSIC_BUCKET: r2,
    KV: kv,
    IMAGES: images, // undefined → handler's catch falls back to the original
  };
  return {
    async get(url: string, headers?: Record<string, string>) {
      const req = new Request(`http://test${url}`, { headers });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return app.fetch(req, env as any);
    },
  };
}

// Pre-bake a single original cover
function seedCover(): {
  counter: Counter;
  imgCounter: { transforms: string[] };
  r2: ReturnType<typeof makeR2>;
  kv: ReturnType<typeof makeKV>;
  images: ReturnType<typeof makeImages>;
} {
  const counter: Counter = { get: [], put: [], head: [] };
  const imgCounter = { transforms: [] as string[] };
  const r2 = makeR2({
    "covers/al-x": {
      data: new TextEncoder().encode("ORIGINAL_JPEG_BYTES_marker"),
      contentType: "image/jpeg",
    },
  }, counter);
  const kv = makeKV();
  const images = makeImages(imgCounter);
  return { counter, imgCounter, r2, kv, images };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("size=128 + R2 miss → transforms once, caches sized slot, serves miss:");
  {
    const { counter, imgCounter, r2, kv, images } = seedCover();
    const { get } = makeApp(buildDb(), r2, kv, images);
    const r = await get("/rest/getCoverArt?id=al-x&size=128");
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === "128", "size echo header");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === "miss", "cache miss header");
    assert(r.headers.get("Vary") === "Accept", "Vary: Accept");
    assert(r.headers.get("Content-Type") === "image/jpeg", "jpeg default (no Accept)");
    assert(imgCounter.transforms[0] === "image/jpeg", "transform ran as jpeg");
    const bytes = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
    assert(bytes === "RESIZED:image/jpeg", "serves transformed bytes");
    assert(counter.put.includes("covers/al-x_s128.jpg"), "wrote format-scoped sized key");
    assert(r2._map.has("covers/al-x_s128.jpg"), "sized key persisted in R2");
  }

  console.log("\nsize=128 + R2 hit → sized slot served, original + transform untouched:");
  {
    const counter: Counter = { get: [], put: [], head: [] };
    const imgCounter = { transforms: [] as string[] };
    const r2 = makeR2({
      "covers/al-x": { data: new TextEncoder().encode("ORIGINAL"), contentType: "image/jpeg" },
      "covers/al-x_s128.jpg": { data: new TextEncoder().encode("SIZED_128"), contentType: "image/jpeg" },
    }, counter);
    const { get } = makeApp(buildDb(), r2, makeKV(), makeImages(imgCounter));
    const r = await get("/rest/getCoverArt?id=al-x&size=128");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === "hit", "cache hit header");
    const bytes = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
    assert(bytes === "SIZED_128", "serves sized bytes (not original)");
    assert(!counter.get.includes("covers/al-x"), "original key never read on hit");
    assert(counter.put.length === 0, "no put on hit");
    assert(imgCounter.transforms.length === 0, "no transform on hit");
  }

  console.log("\nno size param → legacy path hits original key only:");
  {
    const { counter, r2, kv, images } = seedCover();
    const { get } = makeApp(buildDb(), r2, kv, images);
    const r = await get("/rest/getCoverArt?id=al-x");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === null, "no size header on legacy path");
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === null, "no cache header on legacy path");
    assert(counter.get.includes("covers/al-x"), "legacy path reads original key");
    assert(counter.put.length === 0, "legacy path never writes");
    const bytes = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
    assert(bytes.includes("ORIGINAL_JPEG_BYTES_marker"), "legacy serves original bytes");
  }

  console.log("\nsize=999 → snaps up to the 512 bucket (not rejected):");
  {
    const { counter, r2, kv, images } = seedCover();
    const { get } = makeApp(buildDb(), r2, kv, images);
    const r = await get("/rest/getCoverArt?id=al-x&size=999");
    assert(r.status === 200, "200");
    assert(r.headers.get("X-EdgeSonic-Cover-Size") === "512", "snapped to 512");
    assert(counter.put.includes("covers/al-x_s512.jpg"), "cached at the 512 bucket");
  }

  console.log("\nno cover → 404:");
  {
    const counter: Counter = { get: [], put: [], head: [] };
    const r2 = makeR2({}, counter);
    const { get } = makeApp(buildDb(), r2, makeKV(), makeImages({ transforms: [] }));
    const r = await get("/rest/getCoverArt?id=al-none");
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  console.log("\nAccept negotiation → webp / avif slots; */* defaults to jpeg:");
  {
    const { r2, kv, images, counter } = seedCover();
    const { get } = makeApp(buildDb(), r2, kv, images);
    const webp = await get("/rest/getCoverArt?id=al-x&size=128", { Accept: "image/avif,image/webp,*/*" });
    assert(webp.headers.get("Content-Type") === "image/avif", "avif wins when listed first");
    assert(counter.put.includes("covers/al-x_s128.avif"), "avif slot key");

    const wonly = await get("/rest/getCoverArt?id=al-x&size=128", { Accept: "image/webp,*/*" });
    assert(wonly.headers.get("Content-Type") === "image/webp", "webp when only webp listed");
    assert(counter.put.includes("covers/al-x_s128.webp"), "webp slot key");

    const star = await get("/rest/getCoverArt?id=al-x&size=128", { Accept: "*/*" });
    assert(star.headers.get("Content-Type") === "image/jpeg", "*/* falls back to jpeg (spec-safe)");
  }

  console.log("\nIMAGES unavailable → bypass to original, no sized write, no 500:");
  {
    const { counter, r2, kv } = seedCover();
    const { get } = makeApp(buildDb(), r2, kv, undefined); // no IMAGES binding
    const r = await get("/rest/getCoverArt?id=al-x&size=128");
    assert(r.status === 200, `200 not 500 (got ${r.status})`);
    assert(r.headers.get("X-EdgeSonic-Cover-Cache") === "bypass", "bypass header");
    assert(!counter.put.some((k) => k.includes("_s")), "no sized slot written on bypass");
    const bytes = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
    assert(bytes.includes("ORIGINAL_JPEG_BYTES_marker"), "bypass serves original bytes");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
