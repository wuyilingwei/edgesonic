//
// Strategy: in-memory SQLite (node:sqlite) wrapped in a D1 shim (same recipe as
// shares.test.ts), then mount `sharePublicRoutes` on a fresh Hono app and drive
// `app.fetch`. We only exercise the HTML branch + branch selection — the byte
// stream branch is covered by 044's shares.test.ts via the policy simulator.
//
// Run: npx tsx test/subsonic/share_public_html.test.ts
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createQueries } from "../../worker/src/db/queries";
import { sharePublicRoutes, __internals } from "../../worker/src/endpoints/share_public";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ----------------------------------------------------------------------------
// D1 shim — verbatim from shares.test.ts.
// ----------------------------------------------------------------------------
function makeD1Shim(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...args: unknown[]): D1PreparedStatement { binds = args; return stmt; },
      async first<T = unknown>(): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = s.get(...(binds as never[]));
        return (row ?? null) as T | null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return { results: rows as T[] };
      },
      async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
        const s = sqlite.prepare(sql);
        const info = s.run(...(binds as never[]));
        return { meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
      async raw<T = unknown>(): Promise<T[]> {
        const s = sqlite.prepare(sql);
        const rows = s.all(...(binds as never[]));
        return rows as T[];
      },
    } as unknown as D1PreparedStatement;
    return stmt;
  }

  const db = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
      sqlite.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of statements) {
          out.push(await (s as unknown as { run(): Promise<unknown> }).run());
        }
        sqlite.exec("COMMIT");
        return out as T[];
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string): Promise<unknown> { sqlite.exec(sql); return undefined; },
    async dump(): Promise<ArrayBuffer> { throw new Error("dump not supported"); },
    withSession(): unknown { throw new Error("sessions not supported"); },
  } as unknown as D1Database;

  return { db, sqlite };
}

function setupSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      level INTEGER DEFAULT 1
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT,
      album_artist_id TEXT,
      title TEXT,
      sort_title TEXT,
      track INTEGER,
      disc INTEGER,
      duration INTEGER,
      genre TEXT,
      compilation INTEGER DEFAULT 0,
      participants TEXT,
      lyrics TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE shares (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      description TEXT,
      expires_at INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_visited_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX idx_shares_user ON shares(user_id);
    CREATE TABLE share_entries (
      share_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      song_master_id TEXT NOT NULL,
      PRIMARY KEY (share_id, position),
      FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
      FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY,
      master_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT,
      source_dedup_key TEXT,
      parent_instance_id TEXT,
      storage_uri TEXT,
      transcode_profile TEXT,
      suffix TEXT,
      content_type TEXT,
      bit_rate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      duration INTEGER,
      size INTEGER,
      missing INTEGER DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

function seedFixtures(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO users (username, level) VALUES ('alice', 1);
    INSERT INTO albums (id, name) VALUES ('al-a1', 'Album One');
    INSERT INTO song_masters (id, album_id, title, duration) VALUES
      ('s1', 'al-a1', 'Cool Song', 100),
      ('s2', 'al-a1', 'Another', 200);
  `);
}

// ----------------------------------------------------------------------------
// Hono harness — mount sharePublicRoutes verbatim. The public route is
// outside auth middleware so we don't need to stub it.
// ----------------------------------------------------------------------------
function buildApp(db: D1Database) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { env: unknown }).env = { DB: db, INSTANCE_ID: "test-instance" };
    return next();
  });
  app.route("/", sharePublicRoutes);
  return app;
}

interface MockCtx {
  waitUntil: (p: Promise<unknown>) => void;
  awaitAll: () => Promise<unknown[]>;
}
function makeCtx(): MockCtx {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { promises.push(p); },
    awaitAll() { return Promise.all(promises); },
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
async function main() {
  // --- Pure render unit ---
  console.log("escapeHtml covers &<>\"'");
  {
    const out = __internals.escapeHtml(`<script>alert("xss & 'bye')</script>`);
    assert(!out.includes("<script>"), "no raw <script>");
    assert(out.includes("&lt;script&gt;"), "< escaped to &lt;");
    assert(out.includes("&amp;"), "& escaped to &amp;");
    assert(out.includes("&quot;"), '" escaped to &quot;');
    assert(out.includes("&#39;"), "' escaped to &#39;");
  }

  console.log("renderShareHtml produces well-formed HTML with audio src");
  {
    const html = __internals.renderShareHtml({
      shareId: "abc123",
      description: "my mix",
      expiresAt: null,
      viewCount: 3,
      entryCount: 2,
      firstSongTitle: "First Track",
    });
    assert(html.startsWith("<!doctype html>"), "doctype present");
    assert(html.includes(`src="/share/abc123?stream=1"`), "audio src points to ?stream=1");
    assert(html.includes("<audio"), "audio element present");
    assert(html.includes("my mix"), "description rendered as title");
    assert(html.includes("永久有效"), "never-expires line present");
    assert(html.includes("viewed 3 times"), "view count line");
    assert(html.includes("EdgeSonic Share"), "brand label present");
  }

  console.log("renderShareHtml escapes user input in title");
  {
    const html = __internals.renderShareHtml({
      shareId: "id1",
      description: '<img onerror="x" src=y>',
      expiresAt: 1_700_000_000,
      viewCount: 1,
      entryCount: 1,
      firstSongTitle: null,
    });
    assert(!html.includes('<img onerror'), "no raw img tag");
    assert(html.includes("&lt;img"), "img escaped");
    assert(html.includes("过期时间"), "expiry line uses Chinese label");
    // unix 1700000000 → 2023-11-14T22:13:20Z
    assert(html.includes("2023-11-14T22:13:20Z"), "ISO formatted expiry present");
    assert(html.includes("viewed 1 time"), "singular time form for count=1");
  }

  console.log("renderShareHtml falls back to firstSongTitle when no description");
  {
    const html = __internals.renderShareHtml({
      shareId: "id2",
      description: null,
      expiresAt: null,
      viewCount: 0,
      entryCount: 5,
      firstSongTitle: "Hello World",
    });
    assert(html.includes("<title>EdgeSonic · Hello World</title>"), "head title uses song title");
    assert(html.includes(">Hello World</h1>"), "h1 uses song title");
    assert(html.includes("5 tracks"), "subtitle shows entry count");
  }

  // --- Live route ---
  const { db, sqlite } = makeD1Shim();
  setupSchema(sqlite);
  seedFixtures(sqlite);
  const queries = createQueries(db);
  const app = buildApp(db);

  console.log("GET /share/:id → 404 when share missing");
  {
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/does-not-exist"), undefined, ctx as unknown as ExecutionContext);
    assert(r.status === 404, `status=${r.status} expected 404`);
    const body = await r.text();
    assert(body.includes("Share not found"), "body explains share missing");
  }

  console.log("GET /share/:id → 410 when expired");
  {
    const past = Math.floor(Date.now() / 1000) - 60;
    await queries.createShare({
      id: "sh-expired",
      userId: "alice",
      description: null,
      expiresAt: past,
      songIds: ["s1"],
    });
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/sh-expired"), undefined, ctx as unknown as ExecutionContext);
    assert(r.status === 410, `status=${r.status} expected 410 (expired)`);
  }

  console.log("GET /share/:id → 404 when share has no entries");
  {
    // Manually insert a share with no share_entries
    sqlite.exec(`INSERT INTO shares (id, user_id, description, expires_at) VALUES ('sh-empty', 'alice', NULL, NULL)`);
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/sh-empty"), undefined, ctx as unknown as ExecutionContext);
    assert(r.status === 404, `status=${r.status} expected 404 for no entries`);
    const body = await r.text();
    assert(body.includes("no entries"), "body mentions no entries");
  }

  console.log("GET /share/:id → 200 HTML page with audio src and metadata");
  {
    await queries.createShare({
      id: "sh-html-1",
      userId: "alice",
      description: "Family mix <Friday>",
      expiresAt: null,
      songIds: ["s1", "s2"],
    });
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/sh-html-1"), undefined, ctx as unknown as ExecutionContext);
    assert(r.status === 200, `status=${r.status} expected 200`);
    assert(r.headers.get("content-type")?.includes("text/html"), "content-type=text/html");
    assert(r.headers.get("X-EdgeSonic-Share") === "sh-html-1", "X-EdgeSonic-Share header set");
    const body = await r.text();
    assert(body.includes(`src="/share/sh-html-1?stream=1"`), "audio src points to ?stream=1");
    assert(body.includes("Family mix &lt;Friday&gt;"), "description rendered HTML-escaped");
    assert(!body.includes("<Friday>"), "raw < not present in body");
    assert(body.includes("永久有效"), "never expires line present");

    // waitUntil should have queued the increment.
    await ctx.awaitAll();
    const after = await queries.getShareById("sh-html-1");
    assert(after?.view_count === 1, `view_count after HTML hit = 1 (got ${after?.view_count})`);
  }

  console.log("GET /share/:id?stream=1 → bypasses HTML branch (no <audio>, no text/html)");
  {
    // We don't run the full stream path (no MUSIC_BUCKET / R2 in tests). What
    // we assert is that the response is NOT the HTML landing page. The route
    // will reach the byte-stream branch and return 404 "no playable source"
    // since song_instances is empty for s1.
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/sh-html-1?stream=1"), undefined, ctx as unknown as ExecutionContext);
    // body should be plaintext "Shared song has no playable source" 404,
    // never HTML.
    const body = await r.text();
    assert(!body.includes("<!doctype html>"), "stream=1 does not render HTML page");
    assert(!body.includes("<audio"), "stream=1 does not include audio element");
    assert(r.status === 404, `stream=1 status=${r.status} expected 404 (no song_instances in fixture)`);

    // view_count still incremented (both branches bump it once).
    await ctx.awaitAll();
    const after = await queries.getShareById("sh-html-1");
    assert(after?.view_count === 2, `view_count after stream=1 hit = 2 (got ${after?.view_count})`);
  }

  console.log("GET /share/:id → HTML escapes shareId in audio src too");
  {
    // share id with special chars — though we control the id, defense in depth.
    // Use a normal id, just verify the escape path doesn't break the URL.
    await queries.createShare({
      id: "sh-quote-test",
      userId: "alice",
      description: null,
      expiresAt: null,
      songIds: ["s1"],
    });
    const ctx = makeCtx();
    const r = await app.fetch(new Request("http://test/share/sh-quote-test"), undefined, ctx as unknown as ExecutionContext);
    const body = await r.text();
    assert(body.includes(`src="/share/sh-quote-test?stream=1"`), "audio src includes the share id verbatim");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(2);
});
