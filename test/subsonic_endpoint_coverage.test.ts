//
// Verifies that every endpoint defined in the Subsonic 1.16.1 spec is
// registered at /rest/<name> AND /rest/<name>.view, accepting both GET and
// POST. Also checks the EdgeSonic-specific routes (search2, user management,
// scan endpoints) that were added in task 106.
//
// Strategy: mount the full subsonicRoutes Hono app, then hit each path with
// a dummy auth context. We only care that the route resolves (not 404) — the
// response body / status code is irrelevant for coverage. A 401/403/500 means
// the route EXISTS; a 404 means it doesn't.
//
// Run: npx tsx test/subsonic_endpoint_coverage.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { subsonicRoutes } from "../worker/src/endpoints/subsonic";
import { sha256 } from "../worker/src/auth";

let failures = 0;
let passes = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passes++; console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 + KV shim
// ---------------------------------------------------------------------------
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> { return (stmt.get(...boundArgs) ?? null) as T | null; },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: any }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function buildDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY, master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
      avatar_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL, permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT, lyrics TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT NOT NULL, storage_uri TEXT NOT NULL, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0, bit_rate INTEGER, duration INTEGER, etag TEXT, last_modified INTEGER, tag_scanned INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE annotations (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL,
      play_count INTEGER DEFAULT 0, play_date INTEGER, rating INTEGER,
      starred INTEGER DEFAULT 0, starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, comment TEXT, owner TEXT NOT NULL,
      public INTEGER DEFAULT 0, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
      cover_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE playlist_songs (
      playlist_id TEXT NOT NULL, song_master_id TEXT NOT NULL, position INTEGER NOT NULL,
      added_at INTEGER DEFAULT 0, PRIMARY KEY (playlist_id, position)
    );
    CREATE TABLE bookmarks (
      username TEXT NOT NULL, song_master_id TEXT NOT NULL, position_ms INTEGER NOT NULL,
      comment TEXT, changed_by TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
      PRIMARY KEY (username, song_master_id)
    );
    CREATE TABLE play_queues (
      user_id TEXT PRIMARY KEY, song_ids TEXT NOT NULL, current_id TEXT,
      position_ms INTEGER DEFAULT 0, changed_by TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE now_playing (
      username TEXT PRIMARY KEY, song_id TEXT NOT NULL, started_at INTEGER NOT NULL,
      client_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE shares (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, song_ids TEXT NOT NULL,
      description TEXT, expires_at INTEGER, visit_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE radio_stations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, stream_url TEXT NOT NULL,
      homepage_url TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE podcast_channels (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, description TEXT,
      cover_url TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE podcast_episodes (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guid TEXT, title TEXT,
      description TEXT, audio_url TEXT, duration INTEGER, size INTEGER,
      pub_date INTEGER, published_at INTEGER, status TEXT DEFAULT 'new',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, status TEXT NOT NULL,
      total_items INTEGER DEFAULT 0, scanned_items INTEGER DEFAULT 0,
      error_message TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL, base_url TEXT NOT NULL,
      username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1,
      mode TEXT DEFAULT 'library', region TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE subsonic_credentials (
      username TEXT NOT NULL, password TEXT NOT NULL, stream_proxy_strategy TEXT,
      last_used INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE api_keys (api_key TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE rate_limits (
      username TEXT NOT NULL, permission TEXT NOT NULL,
      window_start INTEGER DEFAULT 0, count INTEGER DEFAULT 0,
      PRIMARY KEY (username, permission)
    );
  `);

  // Seed an admin user + permissions
  sqlite.prepare("INSERT INTO users (username, master_password, level) VALUES (?, ?, ?)")
    .run("admin", "x", 3);
  const perms = [
    "browse", "stream", "download", "edit_annotations", "manage_playlists",
    "manage_users", "manage_sources", "manage_files", "manage_radio",
    "manage_podcasts", "share", "edit_tags", "manage_credentials", "manage_permissions",
  ];
  for (const p of perms) {
    sqlite.prepare("INSERT INTO user_permissions VALUES (3, ?, 1, 0)").run(p);
  }
  return sqlite;
}

// ---------------------------------------------------------------------------
// Harness — mount subsonic routes with a fake auth middleware
// ---------------------------------------------------------------------------
function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  // Fake auth: every request is "admin" with full permissions
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    c.set("streamProxyStrategy", "always");
    return next();
  });
  app.route("/rest", subsonicRoutes);
  const env: any = {
    DB: makeD1(sqlite),
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    MUSIC_BUCKET: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      head: async () => null,
    },
    INSTANCE_ID: "test-instance",
    MAX_PROXY_DEPTH: "3",
  };
  return {
    async hit(method: "GET" | "POST", url: string): Promise<Response> {
      return app.fetch(new Request(`http://test${url}`, { method }), env);
    },
  };
}

// ---------------------------------------------------------------------------
// Subsonic 1.16.1 spec endpoint list
// ---------------------------------------------------------------------------
const SPEC_ENDPOINTS = [
  // System
  "ping",
  "getLicense",
  // Browsing
  "getMusicFolders",
  "getIndexes",
  "getMusicDirectory",
  "getGenres",
  "getArtists",
  "getArtist",
  "getAlbum",
  "getSong",
  "getArtistInfo",
  "getArtistInfo2",
  "getAlbumInfo",
  "getAlbumInfo2",
  "getSimilarSongs",
  "getSimilarSongs2",
  "getTopSongs",
  // Album/song lists
  "getAlbumList",
  "getAlbumList2",
  "getRandomSongs",
  "getSongsByGenre",
  "getNowPlaying",
  "getStarred",
  "getStarred2",
  // Searching (all versions)
  "search",
  "search2",
  "search3",
  // Playlists
  "getPlaylists",
  "getPlaylist",
  "createPlaylist",
  "updatePlaylist",
  "deletePlaylist",
  // Media retrieval
  "stream",
  "download",
  "getCoverArt",
  "getLyrics",
  "getAvatar",
  // Media annotation
  "star",
  "unstar",
  "setRating",
  "scrobble",
  // Sharing
  "getShares",
  "createShare",
  "updateShare",
  "deleteShare",
  // Podcast
  "getPodcasts",
  "getNewestPodcasts",
  "refreshPodcasts",
  "createPodcastChannel",
  "deletePodcastChannel",
  "deletePodcastEpisode",
  "downloadPodcastEpisode",
  // Internet radio
  "getInternetRadioStations",
  "createInternetRadioStation",
  "updateInternetRadioStation",
  "deleteInternetRadioStation",
  // User management
  "getUser",
  "getUsers",
  "createUser",
  "updateUser",
  "deleteUser",
  "changePassword",
  // Bookmarks
  "getBookmarks",
  "createBookmark",
  "deleteBookmark",
  "getPlayQueue",
  "savePlayQueue",
  // Media library scanning
  "getScanStatus",
  "startScan",
  // OpenSubsonic extensions
  "getOpenSubsonicExtensions",
  "tokenInfo",
] as const;

// Endpoints intentionally NOT implemented (architecture mismatch)
const NOT_IMPLEMENTED = new Set([
  "getVideos",      // pure audio service
  "getVideoInfo",   // pure audio service
  "hls",            // HLS transcode (089 removed transcoder)
  "getCaptions",    // video captions
  "jukeboxControl", // hardware jukebox
  "getChatMessages", // chat feature
  "addChatMessage",  // chat feature
]);

// Minimal query params for endpoints that require them (so they don't 400
// on missing params — we just want to confirm the route exists)
const REQUIRED_PARAMS: Record<string, string> = {
  getArtist: "?id=ar-1",
  getAlbum: "?id=al-1",
  getSong: "?id=sg-1",
  getMusicDirectory: "?id=al-1",
  getArtistInfo: "?id=ar-1",
  getArtistInfo2: "?id=ar-1",
  getAlbumInfo: "?id=al-1",
  getAlbumInfo2: "?id=al-1",
  getSimilarSongs: "?id=ar-1",
  getSimilarSongs2: "?id=ar-1",
  getTopSongs: "?artist=test",
  getLyrics: "?artist=test&title=test",
  getAvatar: "?username=admin",
  getPlaylist: "?id=pl-1",
  deletePlaylist: "?id=pl-1",
  getAlbumList: "?type=newest",
  getAlbumList2: "?type=newest",
  getSongsByGenre: "?genre=Rock",
  getStarred: "?musicFolderId=0",
  getStarred2: "?musicFolderId=0",
  getInternetRadioStations: "",
  search: "?any=test",
  search2: "?query=test",
  search3: "?query=test",
  getPodcastEpisode: "?id=ep-1",
  getScanStatus: "",
  startScan: "",
  getUser: "?username=admin",
  getLyricsBySongId: "?id=sg-1",
};

async function main() {
  const sqlite = buildDb();
  const { hit } = makeApp(sqlite);

  console.log("\n=== Subsonic 1.16.1 Endpoint Coverage Report ===\n");

  // 1. Verify each spec endpoint has both bare + .view, GET + POST
  let totalChecks = 0;
  let totalPass = 0;
  let totalFail = 0;

  for (const ep of SPEC_ENDPOINTS) {
    const params = REQUIRED_PARAMS[ep] ?? "";
    for (const suffix of ["", ".view"]) {
      for (const method of ["GET", "POST"] as const) {
        totalChecks++;
        const path = `/rest/${ep}${suffix}${params}`;
        try {
          const r = await hit(method, path);
          // Distinguish route-miss 404 (Hono default: empty body, text/plain)
          // from handler 404 (XML body, application/xml content-type).
          // A route that exists but returns 404 from the handler still counts
          // as "covered" — we only care that the route matched.
          const ct = r.headers.get("Content-Type") || "";
          const isRouteMiss = r.status === 404 && !ct.includes("xml");
          if (isRouteMiss) {
            totalFail++;
            console.error(`  ✗ MISSING: ${method} ${path} → 404 (route miss)`);
          } else {
            totalPass++;
          }
        } catch (e) {
          // Throws (e.g. missing R2 object, SQL error) still means the route
          // matched and the handler ran — count as covered.
          totalPass++;
        }
      }
    }
  }

  console.log(`\n--- Coverage Summary ---`);
  console.log(`Spec endpoints checked: ${SPEC_ENDPOINTS.length}`);
  console.log(`Total route checks (bare + .view × GET + POST): ${totalChecks}`);
  console.log(`  Pass: ${totalPass}`);
  console.log(`  Fail: ${totalFail}`);

  // 2. Verify NOT_IMPLEMENTED endpoints are absent (optional — just report)
  console.log(`\n--- Intentionally NOT Implemented (architecture mismatch) ---`);
  for (const ep of NOT_IMPLEMENTED) {
    const r = await hit("GET", `/rest/${ep}`);
    const absent = r.status === 404;
    console.log(`  ${absent ? "✓" : "⚠"} ${ep}: ${absent ? "absent (expected)" : `present (${r.status})`}`);
  }

  // 3. getLyricsBySongId (OpenSubsonic extension, not in base spec)
  console.log(`\n--- OpenSubsonic Extensions ---`);
  {
    const r = await hit("GET", "/rest/getLyricsBySongId?id=sg-1");
    const ct = r.headers.get("Content-Type") || "";
    assert(r.status !== 404 || ct.includes("xml"), "getLyricsBySongId bare path exists");
    const r2 = await hit("GET", "/rest/getLyricsBySongId.view?id=sg-1");
    const ct2 = r2.headers.get("Content-Type") || "";
    assert(r2.status !== 404 || ct2.includes("xml"), "getLyricsBySongId.view path exists");
  }

  // 4. downloadMultiple (EdgeSonic extension)
  {
    const r = await hit("GET", "/rest/downloadMultiple?ids=sg-1");
    assert(r.status !== 404, "downloadMultiple bare path exists");
    const r2 = await hit("GET", "/rest/downloadMultiple.view?ids=sg-1");
    assert(r2.status !== 404, "downloadMultiple.view path exists");
  }

  // 5. getPodcastEpisode (not in spec but EdgeSonic exposes it)
  {
    const r = await hit("GET", "/rest/getPodcastEpisode?id=ep-1");
    const ct = r.headers.get("Content-Type") || "";
    assert(r.status !== 404 || ct.includes("xml"), "getPodcastEpisode bare path exists");
    const r2 = await hit("GET", "/rest/getPodcastEpisode.view?id=ep-1");
    const ct2 = r2.headers.get("Content-Type") || "";
    assert(r2.status !== 404 || ct2.includes("xml"), "getPodcastEpisode.view path exists");
  }

  // Final report
  console.log(`\n=== Final ===`);
  console.log(`Route checks: ${totalPass}/${totalChecks} passed, ${totalFail} failed`);
  console.log(`Extension checks: ${passes} passed, ${failures} failed`);

  const allFail = totalFail + failures;
  if (allFail === 0) {
    console.log("\nALL PASS ✅");
  } else {
    console.log(`\n${allFail} FAILURE(S) ❌`);
  }
  process.exit(allFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});