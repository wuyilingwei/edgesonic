// 147 — POST /storage/files/mkdir endpoint tests.
//
// Covers:
//  • r2: creates a "<path>/.keep" marker object
//  • r2: rejects empty path / ".." traversal segments
//  • non-r2 source: issues MKCOL against srcBaseUrl(src) + path
//  • non-r2 source: 405 (collection already exists) is treated as success
//  • non-r2 source: other failure status → 502
//  • unknown source id → 404
//
// Adapters are shimmed via globalThis.fetch + an in-memory R2 bucket mock so
// no real network calls are made.
//
// Run: npx tsx test/internal/files_mkdir.test.ts

import { Hono } from "hono";
import { filesRoutes } from "../../worker/src/endpoints/storage/files";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// In-memory R2 bucket shim (mirrors test/internal/cross_copy.test.ts)
// ---------------------------------------------------------------------------
interface R2Item { key: string; body: Uint8Array; contentType: string }

function makeR2Bucket() {
  const store = new Map<string, R2Item>();
  return {
    store,
    async put(key: string, body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      let buf: Uint8Array;
      if (body instanceof ArrayBuffer) buf = new Uint8Array(body);
      else if (body instanceof Uint8Array) buf = body;
      else buf = new Uint8Array(0);
      store.set(key, { key, body: buf, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
  };
}

// ---------------------------------------------------------------------------
// D1 shim — only supports the queries mkdir + permissionMiddleware make
// ---------------------------------------------------------------------------
type SourceRec = { id: string; base_url: string; username: string | null; password: string | null; root_path?: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sources: SourceRec[]): any {
  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      return {
        bind(...args: unknown[]) { boundArgs = args; return this; },
        async first<T = unknown>(): Promise<T | null> {
          const trimmed = sql.trim().replace(/\s+/g, " ");
          if (trimmed.includes("FROM user_permissions")) {
            return { enabled: 1, max_rph: 0 } as T;
          }
          if (trimmed.includes("FROM storage_sources WHERE id = ?")) {
            const id = boundArgs[0] as string;
            const row = sources.find((s) => s.id === id);
            return (row ?? null) as T | null;
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
function makeApp(bucket: ReturnType<typeof makeR2Bucket>, sources: SourceRec[]) {
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
  // ── r2: creates a .keep marker ───────────────────────────────────────────
  console.log("\nmkdir r2 → creates .keep marker:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/mkdir", { source: "r2", path: "music/newfolder" });
    assert(r.status === 200, `200 (got ${r.status})`);
    const j = await r.json<{ ok: boolean }>();
    assert(j.ok, "ok=true");
    assert(bucket.store.has("music/newfolder/.keep"), "marker object exists at music/newfolder/.keep");
  }

  // ── r2: strips leading/trailing slashes ──────────────────────────────────
  console.log("\nmkdir r2 → normalizes path slashes:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/mkdir", { source: "r2", path: "/music/sub/" });
    assert(r.status === 200, `200 (got ${r.status})`);
    assert(bucket.store.has("music/sub/.keep"), "marker object exists at music/sub/.keep");
  }

  // ── empty path → 400 ──────────────────────────────────────────────────────
  console.log("\nmkdir empty path → 400:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/mkdir", { source: "r2", path: "" });
    assert(r.status === 400, `400 (got ${r.status})`);
  }

  // ── ".." traversal → 400 ──────────────────────────────────────────────────
  console.log("\nmkdir path traversal → 400:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/mkdir", { source: "r2", path: "music/../secrets" });
    assert(r.status === 400, `400 (got ${r.status})`);
    assert(!bucket.store.has("secrets/.keep"), "no marker escaped the intended prefix");
  }

  // ── non-r2 source: issues MKCOL ──────────────────────────────────────────
  console.log("\nmkdir webdav → issues MKCOL:");
  {
    const bucket = makeR2Bucket();
    const sources: SourceRec[] = [{ id: "wdav1", base_url: "https://dav.example", username: "u", password: "p" }];
    const app = makeApp(bucket, sources);

    const calls: { url: string; method: string }[] = [];
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlStr, method: init?.method || "GET" });
      if (init?.method === "MKCOL") return new Response(null, { status: 201 });
      return originalFetch(url, init);
    };
    try {
      const r = await app.post("/storage/files/mkdir", { source: "wdav1", path: "music/newfolder" });
      assert(r.status === 200, `200 (got ${r.status})`);
      const j = await r.json<{ ok: boolean }>();
      assert(j.ok, "ok=true");
      const mkcol = calls.find((c) => c.method === "MKCOL");
      assert(mkcol !== undefined, "MKCOL request was issued");
      assert(mkcol?.url === "https://dav.example/music/newfolder/", `MKCOL URL correct (got '${mkcol?.url}')`);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── non-r2 source: 405 (already exists) treated as success ──────────────
  console.log("\nmkdir webdav → 405 already-exists is ok:");
  {
    const bucket = makeR2Bucket();
    const sources: SourceRec[] = [{ id: "wdav1", base_url: "https://dav.example", username: "u", password: "p" }];
    const app = makeApp(bucket, sources);

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: string | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "MKCOL") return new Response(null, { status: 405 });
      return originalFetch(_url, init);
    };
    try {
      const r = await app.post("/storage/files/mkdir", { source: "wdav1", path: "music/existing" });
      assert(r.status === 200, `200 (got ${r.status})`);
      const j = await r.json<{ ok: boolean }>();
      assert(j.ok, "ok=true (405 treated as idempotent success)");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── non-r2 source: other failure → 502 ────────────────────────────────────
  console.log("\nmkdir webdav → 500 upstream failure surfaces as 502:");
  {
    const bucket = makeR2Bucket();
    const sources: SourceRec[] = [{ id: "wdav1", base_url: "https://dav.example", username: "u", password: "p" }];
    const app = makeApp(bucket, sources);

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: string | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "MKCOL") return new Response(null, { status: 500 });
      return originalFetch(_url, init);
    };
    try {
      const r = await app.post("/storage/files/mkdir", { source: "wdav1", path: "music/bad" });
      assert(r.status === 502, `502 (got ${r.status})`);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = originalFetch;
    }
  }

  // ── unknown source id → 404 ────────────────────────────────────────────────
  console.log("\nmkdir unknown source → 404:");
  {
    const bucket = makeR2Bucket();
    const app = makeApp(bucket, []);
    const r = await app.post("/storage/files/mkdir", { source: "nonexistent-id", path: "music/x" });
    assert(r.status === 404, `404 (got ${r.status})`);
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
