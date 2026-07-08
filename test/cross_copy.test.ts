// 089 S2 — crossCopy endpoint tests.
//
// Covers:
//   • POST /storage/files/crossCopy with srcUri + destSource='r2' → ok, destUri
//   • destSource is a storage_sources.id for webdav → ok, destUri
//   • destSource not found → 404
//   • destSource type 'url' → 400 read-only
//   • destSource type 'subsonic' → 400 read-only
//   • Missing params → 400
//   • Source stream failure → 502
//
// Adapters are shimmed via globalThis.fetch + an in-memory R2 bucket mock so
// no real network calls are made.
//
// Run: npx tsx test/cross_copy.test.ts

import { Hono } from "hono";
import { filesRoutes } from "../worker/src/endpoints/storage/files";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// In-memory R2 bucket shim
// ---------------------------------------------------------------------------
interface R2Item { key: string; body: Uint8Array; contentType: string }

function makeR2Bucket() {
  const store = new Map<string, R2Item>();
  return {
    store,
    async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; httpMetadata?: { contentType?: string } } | null> {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: new ReadableStream({ start(c) { c.enqueue(item.body); c.close(); } }),
        size: item.body.byteLength,
        httpMetadata: { contentType: item.contentType },
      };
    },
    async put(key: string, body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      let buf: Uint8Array;
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      } else if (body instanceof ArrayBuffer) {
        buf = new Uint8Array(body);
      } else {
        buf = body as Uint8Array;
      }
      store.set(key, { key, body: buf, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async delete(key: string) { store.delete(key); },
  };
}

// ---------------------------------------------------------------------------
// D1 shim (in-memory JS map; only supports the queries crossCopy makes)
// ---------------------------------------------------------------------------
type SourceRec = { id: string; type: string; mode: string; base_url: string; username: string | null; password: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sources: SourceRec[]): any {
  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      return {
        bind(...args: unknown[]) { boundArgs = args; return this; },
        async first<T = unknown>(): Promise<T | null> {
          const trimmed = sql.trim().replace(/\s+/g, " ");
          // Permission middleware: SELECT enabled, max_rph FROM user_permissions WHERE level = ? AND permission = ?
          if (trimmed.includes("FROM user_permissions")) {
            // Grant all permissions, no rate limit
            return { enabled: 1, max_rph: 0 } as T;
          }
          if (trimmed.includes("FROM storage_sources WHERE id = ?")) {
            const id = boundArgs[0] as string;
            const row = sources.find((s) => s.id === id);
            return (row ?? null) as T | null;
          }
          // getSourceCredentials path (SELECT base_url, username, password, ...)
          if (trimmed.includes("FROM storage_sources WHERE type = ?")) {
            const type = boundArgs[0] as string;
            const row = sources.find((s) => s.type === type);
            if (!row) return null;
            // Return shape expected by getSourceCredentials / getDecryptedPassword
            return { base_url: row.base_url, username: row.username, password: row.password, password_encrypted: null, root_path: null } as T;
          }
          return null;
        },
        async all<T = unknown>() { return { results: [] as T[], success: true as const, meta: {} }; },
        async run() { return { success: true as const, meta: { changes: 0 } }; },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Hono app harness
// ---------------------------------------------------------------------------
function makeApp(
  bucket: ReturnType<typeof makeR2Bucket>,
  sources: SourceRec[],
  storageKey?: string,
) {
  const db = makeD1(sources);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", filesRoutes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = {
    DB: db,
    MUSIC_BUCKET: bucket,
  };
  if (storageKey !== undefined) env.STORAGE_KEY = storageKey;

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

// ---------------------------------------------------------------------------
// Utility: make a small audio ReadableStream body for mocking fetch responses
// ---------------------------------------------------------------------------
function fakeAudioResponse(ct = "audio/mpeg"): Response {
  const body = new TextEncoder().encode("FAKE_AUDIO_BYTES");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": ct, "Content-Length": String(body.byteLength) },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  // ── missing params → 400 ─────────────────────────────────────────────────
  console.log("\ncrossCopy missing params → 400:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/crossCopy", { srcUri: "r2://music/a.mp3" });
    assert(r.status === 400, `400 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; error: string }>();
    assert(!j.ok, "ok=false");
    assert(j.error.includes("Missing"), `error mentions Missing (got '${j.error}')`);
  }

  // ── R2 → R2 copy (same bucket) ───────────────────────────────────────────
  console.log("\ncrossCopy R2→R2:");
  {
    const bucket = makeR2Bucket();
    // Pre-seed source file in R2
    await bucket.put("music/src/track.mp3", new TextEncoder().encode("MP3DATA"), {
      httpMetadata: { contentType: "audio/mpeg" },
    });
    const app = makeApp(bucket, []);

    const r = await app.post("/storage/files/crossCopy", {
      srcUri: "r2://music/src/track.mp3",
      destSource: "r2",
      destPath: "dest/track_copy.mp3",
    });
    assert(r.status === 200, `200 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; destUri: string }>();
    assert(j.ok, "ok=true");
    assert(j.destUri === "r2://music/dest/track_copy.mp3", `destUri correct (got '${j.destUri}')`);
    // Verify bytes written to R2
    const written = await bucket.get("music/dest/track_copy.mp3");
    assert(written !== null, "dest file exists in R2");
    if (written) {
      const reader = written.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert(text === "MP3DATA", `content matches (got '${text}')`);
    }
  }

  // ── URL → R2 copy (stream from external URL) ─────────────────────────────
  console.log("\ncrossCopy url://→R2:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.startsWith("https://cdn.example/audio.flac")) return fakeAudioResponse("audio/flac");
      return originalFetch(url);
    };
    try {
      const r = await app.post("/storage/files/crossCopy", {
        srcUri: "url://https://cdn.example/audio.flac",
        destSource: "r2",
        destPath: "downloads/audio.flac",
      });
      assert(r.status === 200, `200 (got ${r.status})`);
      const j = await r.json<{ ok: boolean; destUri: string }>();
      assert(j.ok, "ok=true");
      assert(j.destUri === "r2://music/downloads/audio.flac", `destUri correct (got '${j.destUri}')`);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── WebDAV source → R2 dest ───────────────────────────────────────────────
  console.log("\ncrossCopy webdav→R2:");
  {
    const bucket = makeR2Bucket();
    const sources: SourceRec[] = [
      { id: "wdav1", type: "webdav", mode: "library", base_url: "https://dav.example", username: "u", password: "p" },
    ];
    const app = makeApp(bucket, sources);

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("dav.example")) return fakeAudioResponse("audio/mpeg");
      return originalFetch(url);
    };
    try {
      const r = await app.post("/storage/files/crossCopy", {
        srcUri: "webdav://wdav1/music/album/track.mp3",
        destSource: "r2",
        destPath: "copied/track.mp3",
      });
      assert(r.status === 200, `200 (got ${r.status})`);
      const j = await r.json<{ ok: boolean; destUri: string }>();
      assert(j.ok, `ok=true (error: ${(j as unknown as { error?: string }).error ?? "none"})`);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── R2 → WebDAV dest ─────────────────────────────────────────────────────
  console.log("\ncrossCopy R2→webdav:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/song.mp3", new TextEncoder().encode("R2DATA"), {
      httpMetadata: { contentType: "audio/mpeg" },
    });
    const sources: SourceRec[] = [
      { id: "wdav2", type: "webdav", mode: "sync_only", base_url: "https://sync.dav.example", username: "u", password: "p" },
    ];
    const app = makeApp(bucket, sources);

    const putCalls: { url: string; method: string }[] = [];
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      putCalls.push({ url: urlStr, method: init?.method || "GET" });
      if (init?.method === "PUT" && urlStr.includes("sync.dav.example")) {
        return new Response(null, { status: 201 });
      }
      return originalFetch(url, init);
    };
    try {
      const r = await app.post("/storage/files/crossCopy", {
        srcUri: "r2://music/song.mp3",
        destSource: "wdav2",
        destPath: "backup/song.mp3",
      });
      assert(r.status === 200, `200 (got ${r.status})`);
      const j = await r.json<{ ok: boolean; destUri: string }>();
      assert(j.ok, `ok=true (error: ${(j as unknown as { error?: string }).error ?? "none"})`);
      assert(j.destUri === "webdav://wdav2/backup/song.mp3", `destUri correct (got '${j.destUri}')`);
      const wdPut = putCalls.find((c) => c.method === "PUT");
      assert(wdPut !== undefined, "WebDAV PUT request was issued");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── destSource not found → 404 ────────────────────────────────────────────
  console.log("\ncrossCopy destSource not found → 404:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/x.mp3", new TextEncoder().encode("x"), { httpMetadata: { contentType: "audio/mpeg" } });
    const app = makeApp(bucket, []); // no sources in DB
    const r = await app.post("/storage/files/crossCopy", {
      srcUri: "r2://music/x.mp3",
      destSource: "nonexistent-id",
      destPath: "out/x.mp3",
    });
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  // ── destSource type='url' → 400 read-only ────────────────────────────────
  console.log("\ncrossCopy destSource url → 400:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/x.mp3", new TextEncoder().encode("x"), { httpMetadata: { contentType: "audio/mpeg" } });
    const sources: SourceRec[] = [
      { id: "url1", type: "url", mode: "library", base_url: "https://cdn.example", username: null, password: null },
    ];
    const app = makeApp(bucket, sources);
    const r = await app.post("/storage/files/crossCopy", {
      srcUri: "r2://music/x.mp3",
      destSource: "url1",
      destPath: "out/x.mp3",
    });
    assert(r.status === 400, `400 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; error: string }>();
    assert(!j.ok, "ok=false");
    assert(j.error.includes("read-only"), `error mentions read-only (got '${j.error}')`);
  }

  // ── destSource type='subsonic' → 400 read-only ───────────────────────────
  console.log("\ncrossCopy destSource subsonic → 400:");
  {
    const bucket = makeR2Bucket();
    await bucket.put("music/x.mp3", new TextEncoder().encode("x"), { httpMetadata: { contentType: "audio/mpeg" } });
    const sources: SourceRec[] = [
      { id: "sub1", type: "subsonic", mode: "library", base_url: "https://sub.example", username: "u", password: "p" },
    ];
    const app = makeApp(bucket, sources);
    const r = await app.post("/storage/files/crossCopy", {
      srcUri: "r2://music/x.mp3",
      destSource: "sub1",
      destPath: "out/x.mp3",
    });
    assert(r.status === 400, `400 (got ${r.status})`);
    const j = await r.json<{ ok: boolean; error: string }>();
    assert(!j.ok, "ok=false");
    assert(j.error.includes("read-only"), `error mentions read-only (got '${j.error}')`);
  }

  // ── source stream fails → 502 ────────────────────────────────────────────
  console.log("\ncrossCopy source not found → 502:");
  {
    const bucket = makeR2Bucket(); // R2 bucket is empty
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/crossCopy", {
      srcUri: "r2://music/no-such-file.mp3",
      destSource: "r2",
      destPath: "out/copy.mp3",
    });
    assert(r.status === 502, `502 (got ${r.status})`);
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
