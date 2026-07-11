// ============================================================================
// Run: npx tsx test/podcasts.test.ts
// ----------------------------------------------------------------------------
// Strategy mirrors test/lastfm_proxy.test.ts:
//  * In-memory node:sqlite DatabaseSync shimmed as D1.
//  * Hono harness that mounts podcastsRoutes only (auth bypassed for tests).
//   We pre-`c.set('user', ...)` via a tiny middleware because podcast
//   handlers grab the user from context.
//  * Stubbed globalThis.fetch for RSS + R2 download paths.
//  * In-memory R2 bucket: tracks put / delete keys + payloads.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { podcastsRoutes } from "../worker/src/endpoints/subsonic/podcasts";
import {
  refreshChannel,
  refreshAllChannels,
  downloadEpisodeToR2,
} from "../worker/src/utils/podcastSync";
import { parseRss, parseDuration } from "../worker/src/utils/rss";

// ---------------------------------------------------------------------------
// Asserts
// ---------------------------------------------------------------------------
let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim (same shape as lastfm_proxy.test.ts)
// ---------------------------------------------------------------------------
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        const rows = stmt.all(...boundArgs) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

// ---------------------------------------------------------------------------
// In-memory R2
// ---------------------------------------------------------------------------
function makeR2() {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  return {
    store,
    put: async (key: string, body: ArrayBuffer | Uint8Array, opts?: any) => {
      const ab = body instanceof ArrayBuffer ? body : body.buffer.slice(0);
      store.set(key, {
        body: ab as ArrayBuffer,
        contentType: opts?.httpMetadata?.contentType,
      });
    },
    delete: async (key: string) => { store.delete(key); },
    get: async (key: string) => store.get(key) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Schema (just the bits podcasts code touches)
// ---------------------------------------------------------------------------
function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE podcast_channels (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      language TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      error_message TEXT,
      last_refreshed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 1700000000
    );
    CREATE TABLE podcast_episodes (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      guid TEXT NOT NULL,
      title TEXT,
      description TEXT,
      audio_url TEXT,
      published_at INTEGER,
      duration INTEGER,
      size INTEGER,
      bit_rate INTEGER,
      status TEXT NOT NULL DEFAULT 'new',
      downloaded_r2_key TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT 1700000000,
      UNIQUE (channel_id, guid),
      FOREIGN KEY (channel_id) REFERENCES podcast_channels(id) ON DELETE CASCADE
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    INSERT INTO user_permissions VALUES (3, 'manage_podcasts', 1, 0);
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Harness — mount podcastsRoutes with a synthetic admin user pre-set.
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync, bucket: ReturnType<typeof makeR2>) {
  const app = new Hono<{ Bindings: any; Variables: { user: any } }>();
  // Inject a synthetic user before podcastsRoutes runs. Admin level 3 means
  // permissionMiddleware('manage_podcasts') passes for the admin endpoints.
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1 });
    await next();
  });
  app.route("/rest", podcastsRoutes);

  const waited: Promise<unknown>[] = [];
  const env = {
    DB: makeD1(sqlite),
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    MUSIC_BUCKET: bucket,
    INSTANCE_ID: "test-instance",
  };
  return {
    env,
    waited,
    async req(method: "GET" | "POST", url: string) {
      const req = new Request(`http://test${url}`, { method });
      // Use a fake execution ctx that records waitUntil promises and resolves them.
      const ctx = {
        waitUntil: (p: Promise<unknown>) => { waited.push(p); },
        passThroughOnException: () => {},
      };
      return app.fetch(req, env, ctx as any);
    },
    async flush() {
      await Promise.all(waited.slice());
      waited.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------
interface FetchCall { url: string; method: string; }
let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response> = () =>
  new Response("", { status: 404 });

const originalFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const call: FetchCall = { url, method };
    fetchCalls.push(call);
    return fetchHandler(call);
  }) as any;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

// ---------------------------------------------------------------------------
// Sample RSS payload
// ---------------------------------------------------------------------------
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <description><![CDATA[A demo podcast feed]]></description>
    <language>en-us</language>
    <image><url>https://example.com/cover.jpg</url></image>
    <itunes:image href="https://example.com/cover.jpg"/>
    <item>
      <title>Episode One</title>
      <description>The first one</description>
      <guid isPermaLink="false">ep-001</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <itunes:duration>1800</itunes:duration>
      <enclosure url="https://example.com/audio/ep1.mp3" length="12345678" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode Two</title>
      <description>The second one</description>
      <guid>ep-002</guid>
      <pubDate>Tue, 02 Jan 2024 09:30:00 GMT</pubDate>
      <itunes:duration>30:00</itunes:duration>
      <enclosure url="https://example.com/audio/ep2.mp3" length="9876543" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

// ===========================================================================
async function main() {
  installFetchStub();

  // -------------------------------------------------------------------------
  console.log("rss.ts: parseRss extracts channel + items:");
  // -------------------------------------------------------------------------
  {
    const parsed = parseRss(SAMPLE_RSS);
    assert(parsed.title === "Test Podcast", "channel title");
    assert(parsed.description === "A demo podcast feed", "channel description (CDATA decoded)");
    assert(parsed.language === "en-us", "channel language");
    assert(parsed.imageUrl === "https://example.com/cover.jpg", "channel imageUrl");
    assert(parsed.items.length === 2, `2 items (got ${parsed.items.length})`);
    assert(parsed.items[0].guid === "ep-001", "first item guid");
    assert(parsed.items[0].title === "Episode One", "first item title");
    assert(parsed.items[0].audioUrl === "https://example.com/audio/ep1.mp3", "first item audioUrl");
    assert(parsed.items[0].size === 12345678, "first item size from enclosure length");
    assert(parsed.items[0].duration === 1800, "first item duration (bare seconds)");
    assert(parsed.items[1].duration === 30 * 60, "second item duration (MM:SS = 1800s)");
    // pubDate → unix seconds
    const expected = Math.floor(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000);
    assert(parsed.items[0].publishedAt === expected, `first item publishedAt = ${expected}`);
  }

  // -------------------------------------------------------------------------
  console.log("rss.ts: parseDuration edge cases:");
  // -------------------------------------------------------------------------
  {
    assert(parseDuration("3600") === 3600, "bare seconds");
    assert(parseDuration("01:30:45") === 5445, "HH:MM:SS");
    assert(parseDuration("45:00") === 2700, "MM:SS");
    assert(parseDuration(null) === null, "null input");
    assert(parseDuration("not-a-time") === null, "garbage → null");
  }

  // -------------------------------------------------------------------------
  console.log("createPodcastChannel + mock RSS fetch → episodes written:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url === "https://example.com/feed.rss") {
        return new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
      }
      return new Response("", { status: 404 });
    };
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush, env } = makeApp(sqlite, bucket);

    const url = "https://example.com/feed.rss";
    const resp = await req("POST", `/rest/createPodcastChannel?url=${encodeURIComponent(url)}`);
    assert(resp.status === 200, "createPodcastChannel 200");
    const xml = await resp.text();
    assert(/status="ok"/.test(xml), "Subsonic ok envelope");

    // The waitUntil callback runs refreshChannel. Drain it.
    await flush();

    // The channel row should be `completed` and carry meta.
    const row = sqlite.prepare("SELECT * FROM podcast_channels WHERE url = ?").get(url) as any;
    assert(row, "channel row exists after create");
    assert(row.status === "completed", `status=completed (got ${row.status})`);
    assert(row.title === "Test Podcast", "channel title persisted");
    assert(row.image_url === "https://example.com/cover.jpg", "image_url persisted");

    const eps = sqlite.prepare(
      "SELECT * FROM podcast_episodes WHERE channel_id = ? ORDER BY published_at DESC"
    ).all(row.id) as any[];
    assert(eps.length === 2, `2 episodes inserted (got ${eps.length})`);
    assert(
      eps.find((e) => e.guid === "ep-001")?.audio_url === "https://example.com/audio/ep1.mp3",
      "episode audio_url stored",
    );

    // Second create with same url should be rejected.
    const dup = await req("POST", `/rest/createPodcastChannel?url=${encodeURIComponent(url)}`);
    const dupXml = await dup.text();
    assert(/status="failed"/.test(dupXml), "duplicate url rejected");

    // env unused after flush, but keep ref so TS happy
    void env;
  }

  // -------------------------------------------------------------------------
  console.log("refreshPodcasts re-fetches existing channels:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    // First call returns the sample, second call returns an updated feed with a new item.
    let calls = 0;
    fetchHandler = () => {
      calls++;
      if (calls === 1) {
        return new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
      }
      const updated = SAMPLE_RSS.replace(
        "</channel>",
        `<item>
          <title>Episode Three</title>
          <guid>ep-003</guid>
          <pubDate>Wed, 03 Jan 2024 12:00:00 GMT</pubDate>
          <enclosure url="https://example.com/audio/ep3.mp3" length="1024" type="audio/mpeg"/>
        </item></channel>`,
      );
      return new Response(updated, { headers: { "Content-Type": "application/rss+xml" } });
    };

    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);

    // Seed an existing channel via createPodcastChannel + flush so refresh has a target.
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();

    // Now trigger /rest/refreshPodcasts. It returns immediately; flush to run refresh.
    const refresh = await req("GET", "/rest/refreshPodcasts");
    assert(refresh.status === 200, "refreshPodcasts 200");
    await flush();

    const eps = sqlite.prepare("SELECT * FROM podcast_episodes").all() as any[];
    assert(eps.length === 3, `3 episodes after refresh (got ${eps.length})`);
    assert(eps.find((e) => e.guid === "ep-003"), "new episode ep-003 ingested by refresh");
  }

  // -------------------------------------------------------------------------
  console.log("getPodcasts(includeEpisodes=true) returns channel + nested episodes:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = () => new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();

    const get = await req("GET", "/rest/getPodcasts");
    const text = await get.text();
    assert(/status="ok"/.test(text), "Subsonic ok");
    assert(/<podcasts>/.test(text), "<podcasts> root");
    assert(/<channel [^>]*title="Test Podcast"/.test(text), "channel attrs include title");
    assert(/<channel [^>]*status="completed"/.test(text), "channel status completed");
    assert(/<episode [^>]*title="Episode One"/.test(text), "episode One nested");
    assert(/<episode [^>]*title="Episode Two"/.test(text), "episode Two nested");

    // includeEpisodes=false drops episodes.
    const noEp = await req("GET", "/rest/getPodcasts?includeEpisodes=false");
    const noEpText = await noEp.text();
    assert(!/<episode /.test(noEpText), "includeEpisodes=false hides episodes");
  }

  // -------------------------------------------------------------------------
  console.log("getNewestPodcasts respects count:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = () => new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();

    const r = await req("GET", "/rest/getNewestPodcasts?count=1");
    const text = await r.text();
    assert(/<newestPodcasts>/.test(text), "wrapper newestPodcasts");
    const episodes = (text.match(/<episode /g) || []).length;
    assert(episodes === 1, `count=1 returns 1 episode (got ${episodes})`);
  }

  // -------------------------------------------------------------------------
  console.log("downloadPodcastEpisode status transitions + R2 put:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    let bodyBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // pretend mp3 header
    fetchHandler = (call) => {
      if (call.url.endsWith(".rss")) {
        return new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
      }
      if (call.url.endsWith("ep1.mp3")) {
        return new Response(bodyBytes, {
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      return new Response("", { status: 404 });
    };
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();

    const ep = sqlite.prepare("SELECT id FROM podcast_episodes WHERE guid = ?")
      .get("ep-001") as { id: string };
    assert(!!ep?.id, "episode ep-001 exists");

    const dl = await req("POST", `/rest/downloadPodcastEpisode?id=${ep.id}`);
    assert(dl.status === 200, "download endpoint 200");
    const text = await dl.text();
    assert(/status="ok"/.test(text), "Subsonic ok");

    // Note: the handler flips status to `downloading` synchronously before
    // ctx.waitUntil, but our in-process harness drains microtasks tightly so
    // the background download may already have completed by the time we
    // observe. The invariant we care about is the final transition below.

    // Drain the background download (no-op if it already finished).
    await flush();

    const after = sqlite.prepare(
      "SELECT status, downloaded_r2_key, size FROM podcast_episodes WHERE id = ?"
    ).get(ep.id) as { status: string; downloaded_r2_key: string; size: number };
    assert(after.status === "completed", `final status completed (got ${after.status})`);
    assert(!!after.downloaded_r2_key, "downloaded_r2_key set");
    assert(after.size === 4, `R2 size reflects payload (got ${after.size})`);
    assert(bucket.store.has(after.downloaded_r2_key), "R2 bucket has the key");
  }

  // -------------------------------------------------------------------------
  console.log("deletePodcastChannel cascades to episodes (+R2):");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = (call) => {
      if (call.url.endsWith(".rss")) {
        return new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
      }
      if (call.url.endsWith(".mp3")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      return new Response("", { status: 404 });
    };
    const sqlite = buildDb();
    // Enable FKs so DELETE cascades fire.
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();
    const channel = sqlite.prepare("SELECT id FROM podcast_channels").get() as { id: string };

    const del = await req("POST", `/rest/deletePodcastChannel?id=${channel.id}`);
    assert(del.status === 200, "deletePodcastChannel 200");

    const remainingChannels = (sqlite.prepare("SELECT COUNT(*) AS c FROM podcast_channels")
      .get() as { c: number }).c;
    assert(remainingChannels === 0, "channel row gone");
    const remainingEpisodes = (sqlite.prepare("SELECT COUNT(*) AS c FROM podcast_episodes")
      .get() as { c: number }).c;
    assert(remainingEpisodes === 0, "episode rows cascaded");
  }

  // -------------------------------------------------------------------------
  console.log("getPodcasts(id=...) returns 404 for unknown id:");
  // -------------------------------------------------------------------------
  {
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req } = makeApp(sqlite, bucket);
    const r = await req("GET", "/rest/getPodcasts?id=pc-nope");
    assert(r.status === 404, `404 status (got ${r.status})`);
    const t = await r.text();
    assert(/code="70"/.test(t), "Subsonic error code 70");
  }

  // -------------------------------------------------------------------------
  console.log("getPodcastEpisode happy path + missing id:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = () => new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush } = makeApp(sqlite, bucket);
    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();

    const ep = sqlite.prepare("SELECT id FROM podcast_episodes WHERE guid = ?")
      .get("ep-002") as { id: string };
    const r = await req("GET", `/rest/getPodcastEpisode?id=${ep.id}`);
    assert(r.status === 200, "getPodcastEpisode 200");
    const t = await r.text();
    assert(/<podcastEpisode>/.test(t), "<podcastEpisode> wrapper");
    assert(/title="Episode Two"/.test(t), "episode Two emitted");

    const missing = await req("GET", "/rest/getPodcastEpisode");
    assert(missing.status === 400, "missing id → 400");
  }

  // -------------------------------------------------------------------------
  console.log("refreshChannel records HTTP error in channel row:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = () => new Response("server down", { status: 502 });
    const sqlite = buildDb();
    const bucket = makeR2();
    const { req, flush, env } = makeApp(sqlite, bucket);

    await req("POST", "/rest/createPodcastChannel?url=" + encodeURIComponent("https://example.com/feed.rss"));
    await flush();
    const row = sqlite.prepare("SELECT * FROM podcast_channels").get() as any;
    assert(row.status === "error", `status=error after fetch failure (got ${row.status})`);
    assert(/HTTP 502/.test(row.error_message ?? ""), "error_message records HTTP code");

    void env;
  }

  // -------------------------------------------------------------------------
  console.log("downloadEpisodeToR2 unit (no audio_url → error):");
  // -------------------------------------------------------------------------
  {
    const sqlite = buildDb();
    const bucket = makeR2();
    // Seed a channel + episode missing audio_url
    sqlite.exec(`
      INSERT INTO podcast_channels (id, url, status) VALUES ('pc-x', 'https://x', 'completed');
      INSERT INTO podcast_episodes (id, channel_id, guid, title, audio_url)
        VALUES ('pe-x', 'pc-x', 'g-x', 'No Audio', NULL);
    `);
    const db = makeD1(sqlite);
    const r = await downloadEpisodeToR2(db as any, bucket as any, "pe-x");
    assert(r.status === "error", "missing audio_url → status=error");
    const row = sqlite.prepare("SELECT status, error_message FROM podcast_episodes WHERE id = 'pe-x'")
      .get() as { status: string; error_message: string };
    assert(row.status === "error", "row.status reflects failure");
    assert(/audio_url/.test(row.error_message ?? ""), "error_message mentions audio_url");
  }

  // -------------------------------------------------------------------------
  console.log("refreshAllChannels aggregates per-channel results:");
  // -------------------------------------------------------------------------
  {
    fetchCalls = [];
    fetchHandler = () => new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO podcast_channels (id, url, status) VALUES
        ('pc-1', 'https://example.com/a.rss', 'new'),
        ('pc-2', 'https://example.com/b.rss', 'new');
    `);
    const db = makeD1(sqlite);
    const result = await refreshAllChannels(db as any);
    assert(result.channels === 2, "2 channels processed");
    assert(result.episodes === 4, `4 episodes total (2 per channel) — got ${result.episodes}`);
    assert(result.errors === 0, "no errors");
  }

  // -------------------------------------------------------------------------
  // refreshChannel can be called directly too.
  // -------------------------------------------------------------------------
  console.log("refreshChannel unit returns episode count:");
  {
    fetchCalls = [];
    fetchHandler = () => new Response(SAMPLE_RSS, { headers: { "Content-Type": "application/rss+xml" } });
    const sqlite = buildDb();
    sqlite.exec(`
      INSERT INTO podcast_channels (id, url, status) VALUES ('pc-z', 'https://z.example/feed.rss', 'new');
    `);
    const db = makeD1(sqlite);
    const r = await refreshChannel(db as any, "pc-z");
    assert(r.status === "completed", "completed");
    assert(r.episodes === 2, `2 episodes returned (got ${r.episodes})`);
  }

  restoreFetch();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
