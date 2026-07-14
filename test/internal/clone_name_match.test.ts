// Clone relationships must use entity metadata when remote and local ids differ.
// Run: npx tsx test/internal/clone_name_match.test.ts

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { cloneRoutes } from "../../worker/src/endpoints/edgesonic/clone";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let bound: any[] = [];
    return {
      bind(...args: any[]) { bound = args; return this; },
      async first<T = any>(): Promise<T | null> { return (stmt.get(...bound) ?? null) as T | null; },
      async all<T = any>() { return { results: stmt.all(...bound) as T[], success: true, meta: {} }; },
      async run() { const info = stmt.run(...bound); return { success: true, meta: { changes: Number(info.changes ?? 0) } }; },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((stmt) => stmt.run())) };
}

function buildDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT NOT NULL, level INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE user_permissions (level INTEGER NOT NULL, permission TEXT NOT NULL, enabled INTEGER DEFAULT 0, PRIMARY KEY (level, permission));
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, lyrics TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, FOREIGN KEY (album_id) REFERENCES albums(id), FOREIGN KEY (artist_id) REFERENCES artists(id));
    CREATE TABLE annotations (user_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL, play_count INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, starred_at INTEGER, PRIMARY KEY (user_id, item_id, item_type));
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, public INTEGER DEFAULT 0, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, comment TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
    CREATE TABLE playlist_songs (playlist_id TEXT NOT NULL, song_master_id TEXT NOT NULL, position INTEGER NOT NULL, added_at INTEGER DEFAULT 0, PRIMARY KEY (playlist_id, position));

    INSERT INTO users (username, master_password, level) VALUES ('alice', 'hash', 1);
    INSERT INTO artists (id, name, sort_name) VALUES ('artist-local', 'Local Singer', 'local singer');
    INSERT INTO artists (id, name, sort_name) VALUES ('artist-other', 'Other Singer', 'other singer');
    INSERT INTO albums (id, name, sort_name, year) VALUES ('album-local', 'Same Album', 'same album', 2024);
    INSERT INTO albums (id, name, sort_name, year) VALUES ('album-other', 'Other Album', 'other album', 2024);
    INSERT INTO song_masters (id, album_id, artist_id, album_artist_id, title, sort_title, track, disc, duration)
      VALUES ('song-local', 'album-local', 'artist-local', 'artist-local', '01 - Target Song', '01 - target song', 1, 1, 210);
    INSERT INTO song_masters (id, album_id, artist_id, album_artist_id, title, sort_title, track, disc, duration)
      VALUES ('remote-song-collision', 'album-other', 'artist-other', 'artist-other', 'Target Song', 'target song', 1, 1, 210);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "alice", level: 1, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/edgesonic", cloneRoutes);
  const env = { DB: makeD1(sqlite) };
  return {
    async post(path: string, body: unknown) {
      return app.fetch(new Request(`http://test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }), env as any);
    },
  };
}

async function main() {
  const db = buildDb();
  const app = makeApp(db);

  console.log("starred items match by names, not remote ids:");
  const starred = await app.post("/edgesonic/clone/upsertStarred", {
    userId: "alice",
    sourceKey: "remote-source",
    items: [
      { id: "remote-song", type: "song", title: "Target Song", artist: "Local Singer", album: "Same Album", duration: 211, track: 1, disc: 1 },
      { id: "remote-album", type: "album", name: "Same Album", artist: "Local Singer", year: 2024 },
      { id: "remote-artist", type: "artist", name: "Local Singer" },
    ],
  });
  assert(starred.status === 200, `starred status 200 (got ${starred.status})`);
  const starredRows = db.prepare("SELECT item_id, item_type FROM annotations WHERE user_id='alice' ORDER BY item_type").all() as Array<{ item_id: string; item_type: string }>;
  assert(starredRows.map((row) => `${row.item_type}:${row.item_id}`).join(",") === "album:album-local,artist:artist-local,song:song-local", "all starred types use local ids");
  assert(!db.prepare("SELECT 1 FROM annotations WHERE item_id IN ('remote-song','remote-album','remote-artist')").get(), "remote ids are not written as annotations");

  console.log("playlist entries match by song metadata and skip unknown entries:");
  const playlist = await app.post("/edgesonic/clone/upsertPlaylist", {
    userId: "alice",
    sourceKey: "remote-source",
    playlist: { id: "remote-playlist", name: "Remote Favourites", owner: "alice" },
    entries: [
      { id: "remote-song", title: "Target Song", artist: "Local Singer", album: "Same Album", duration: 210, track: 1, disc: 1 },
      { id: "remote-missing", title: "Not In Local Library", artist: "Missing", album: "Missing Album", duration: 100 },
    ],
  });
  assert(playlist.status === 200, `playlist status 200 (got ${playlist.status})`);
  const playlistBody = await playlist.json() as { inserted?: number; unmatched?: number };
  assert(playlistBody.inserted === 1 && playlistBody.unmatched === 1, "one song matched and one song was reported missing");
  const entry = db.prepare("SELECT song_master_id FROM playlist_songs WHERE playlist_id='remote-playlist'").get() as { song_master_id: string } | undefined;
  assert(entry?.song_master_id === "song-local", "playlist uses the metadata-matched local song");
  assert(!db.prepare("SELECT 1 FROM playlist_songs WHERE song_master_id='remote-missing'").get(), "unknown remote song is not inserted");

  if (failures) process.exit(1);
  console.log("\nALL PASS");
}

main().catch((error) => { console.error(error); process.exit(1); });
