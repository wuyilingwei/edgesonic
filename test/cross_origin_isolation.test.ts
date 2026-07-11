//
// Coverage:
//  1. Feature ON → response carries COOP=same-origin, COEP=require-corp,
//                  CORP=same-origin on a vanilla handler.
//  2. Feature OFF ('0' in feature_strings) → response carries NONE of the
//                  three headers (middleware skips entirely).
//  3. Default fallback — feature row absent in D1 → headers stamped (the
//                  middleware treats missing as ON, matching the
//                  0022 migration default).
//  4. Handler-set CORP wins — if a route sets CORP=cross-origin (e.g. a
//                  future public-embed endpoint), the middleware does NOT
//                  overwrite it.
//  5. Public /share/:id parity — the share route goes through the SAME global
//                  middleware (it is registered on the bare Hono app), so a
//                  GET against a Hono route mounted under the middleware
//                  inherits the headers.
//  6. KV cache hit — second call within TTL avoids a D1 round-trip.
//
// Run: npx tsx test/cross_origin_isolation.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { crossOriginIsolationMiddleware } from "../worker/src/middleware/cross_origin_isolation";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 + KV shims (same shape as the rest of the test suite).
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
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number; last_row_id?: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
    };
  }
  return {
    prepare,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

interface CountingKV {
  store: Map<string, string>;
  hits: number;
  misses: number;
  get(k: string): Promise<string | null>;
  put(k: string, v: string, _opts?: unknown): Promise<void>;
  delete(k: string): Promise<void>;
}

function makeKV(): CountingKV {
  const store = new Map<string, string>();
  const self: CountingKV = {
    store,
    hits: 0,
    misses: 0,
    async get(k: string) {
      const v = store.has(k) ? store.get(k)! : null;
      if (v !== null) self.hits++; else self.misses++;
      return v;
    },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
  return self;
}

function buildDb(featureValue?: string) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE feature_strings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at INTEGER DEFAULT 0
    );
  `);
  if (typeof featureValue === "string") {
    sqlite.prepare(
      "INSERT INTO feature_strings (key, value, description, updated_at) VALUES (?, ?, ?, ?)",
    ).run("enable_cross_origin_isolation", featureValue, "test seed", 0);
  }
  return { sqlite, db: makeD1(sqlite) };
}

// ---------------------------------------------------------------------------
// App builder — mounts the middleware in front of two routes:
//   GET /ping     → vanilla response (covers the default CORP path)
//  GET /share/:id → simulates the public share route (registered on the
//                   bare app, same as production index.ts), so we verify
//                   the share path inherits the headers.
//   GET /cors-ext → a hypothetical handler that opts into CORP=cross-origin
//                   before middleware runs (Part F precedent).
// ---------------------------------------------------------------------------
function makeApp(env: { DB: unknown; KV: unknown }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = env;
    await next();
  });
  app.use("*", crossOriginIsolationMiddleware);
  app.get("/ping", (c) => c.text("pong"));
  app.get("/share/:id", (c) => c.text(`share:${c.req.param("id")}`));
  app.get("/cors-ext", (c) => {
    // Set CORP manually BEFORE middleware fills the default.
    c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return c.text("ext");
  });
  return app;
}

async function run() {
  // -------------------------------------------------------------------------
  // 1. Feature ON path
  // -------------------------------------------------------------------------
  console.log("feature ON:");
  {
    const { db } = buildDb("1");
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    const r = await app.request("/ping");
    assert(r.status === 200, "200 OK");
    assert(r.headers.get("Cross-Origin-Opener-Policy") === "same-origin",
      "COOP same-origin");
    assert(r.headers.get("Cross-Origin-Embedder-Policy") === "require-corp",
      "COEP require-corp");
    assert(r.headers.get("Cross-Origin-Resource-Policy") === "same-origin",
      "CORP same-origin default");
  }

  // -------------------------------------------------------------------------
  // 2. Feature OFF path
  // -------------------------------------------------------------------------
  console.log("\nfeature OFF:");
  {
    const { db } = buildDb("0");
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    const r = await app.request("/ping");
    assert(r.status === 200, "200 OK");
    assert(r.headers.get("Cross-Origin-Opener-Policy") === null,
      "COOP NOT set when disabled");
    assert(r.headers.get("Cross-Origin-Embedder-Policy") === null,
      "COEP NOT set when disabled");
    assert(r.headers.get("Cross-Origin-Resource-Policy") === null,
      "CORP NOT set when disabled");
  }

  // -------------------------------------------------------------------------
  // 3. Default fallback (row absent) — defaults to ON
  // -------------------------------------------------------------------------
  console.log("\ndefault fallback (row absent):");
  {
    const { db } = buildDb(undefined);
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    const r = await app.request("/ping");
    assert(r.headers.get("Cross-Origin-Opener-Policy") === "same-origin",
      "missing row → COOP still stamped (fallback '1')");
    assert(r.headers.get("Cross-Origin-Embedder-Policy") === "require-corp",
      "missing row → COEP still stamped");
  }

  // -------------------------------------------------------------------------
  // 4. Handler-set CORP wins
  // -------------------------------------------------------------------------
  console.log("\nhandler-set CORP wins:");
  {
    const { db } = buildDb("1");
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    const r = await app.request("/cors-ext");
    assert(r.headers.get("Cross-Origin-Opener-Policy") === "same-origin",
      "COOP still stamped");
    assert(r.headers.get("Cross-Origin-Resource-Policy") === "cross-origin",
      "CORP=cross-origin from handler is preserved (not overwritten by middleware)");
  }

  // -------------------------------------------------------------------------
  // 5. Public /share/:id parity
  // -------------------------------------------------------------------------
  console.log("\npublic /share/:id parity:");
  {
    const { db } = buildDb("1");
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    const r = await app.request("/share/abc");
    assert(r.status === 200, "200 OK");
    assert(await r.text() === "share:abc", "share body intact");
    assert(r.headers.get("Cross-Origin-Opener-Policy") === "same-origin",
      "share inherits COOP");
    assert(r.headers.get("Cross-Origin-Embedder-Policy") === "require-corp",
      "share inherits COEP");
    assert(r.headers.get("Cross-Origin-Resource-Policy") === "same-origin",
      "share inherits CORP=same-origin (Part F default)");
  }

  // -------------------------------------------------------------------------
  // 6. In-isolate memory cache on the second call (089)
  // -------------------------------------------------------------------------
  // The features util now fronts KV with a per-env in-memory cache, so a second
  // request in the same isolate is served from memory — it touches neither D1
  // nor KV. (Same env object across both requests → WeakMap cache reused.)
  console.log("\nfeature cache:");
  {
    const { db } = buildDb("1");
    const kv = makeKV();
    const app = makeApp({ DB: db, KV: kv });
    await app.request("/ping");
    const getsAfterFirst = kv.hits + kv.misses;
    await app.request("/ping");
    assert(kv.hits + kv.misses === getsAfterFirst,
      "second request served from in-isolate memory cache (no extra KV read)");
    assert(getsAfterFirst === 0, "first request went to D1 directly (no KV reads)");
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nAll cross_origin_isolation tests passed.");
  }
}

run().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
