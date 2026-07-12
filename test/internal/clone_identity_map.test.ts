// Regression coverage for clone identity mapping:
//  1. upsertMaster reuses an existing local song_master when upstream id differs
//  2. upsertStarred resolves remote song ids through clone_id_map
//  3. upsertPlaylist resolves remote song ids and falls back when upstream owner is missing
//
// Run: npx tsx test/internal/clone_identity_map.test.ts

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
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
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
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      master_password TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE user_permissions (
      level INTEGER NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      max_rph INTEGER DEFAULT 0,
      PRIMARY KEY (level, permission)
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_name TEXT,
      year INTEGER,
      genre TEXT,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY,
      album_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      album_artist_id TEXT,
      title TEXT NOT NULL,
      sort_title TEXT,
      track INTEGER,
      disc INTEGER,
      duration INTEGER,
      genre TEXT,
      compilation INTEGER DEFAULT 0,
      lyrics TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      FOREIGN KEY (album_id) REFERENCES albums(id),
      FOREIGN KEY (artist_id) REFERENCES artists(id)
    );
    CREATE TABLE annotations (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('song', 'album', 'artist')),
      play_count INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      starred_at INTEGER,
      PRIMARY KEY (user_id, item_id, item_type)
    );
    CREATE TABLE playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      public INTEGER DEFAULT 0,
      song_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      comment TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE TABLE playlist_songs (
      playlist_id TEXT NOT NULL,
      song_master_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, position),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (song_master_id) REFERENCES song_masters(id) ON DELETE CASCADE
    );

    INSERT INTO users (username, master_password, level, enabled) VALUES ('admin', 'hash', 3, 1);
    INSERT INTO user_permissions (level, permission, enabled) VALUES (3, 'manage_users', 1);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-local', 'JAY''ED / Ms.OOJA', 'jay''ed / ms.ooja');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-local', 'また君と', 'また君と');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, duration)
      VALUES ('sg-local', 'al-local', 'ar-local', '01 - また君と (再度和你)', '01 - また君と (再度和你)', 281);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-opus-local', 'Triodust, Chia-Wei Hsu', 'triodust, chia-wei hsu');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-opus', 'OPUS: Echo of Starsong Complete Soundtrack', 'opus: echo of starsong complete soundtrack');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, track, disc, duration)
      VALUES ('sg-opus-river', 'al-opus', 'ar-opus-local', '-Bonus Track- River (Official Trailer #1 Edit)', '-Bonus Track- River (Official Trailer #1 Edit)', 64, 2, 56);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-unknown-local', '未知艺术家', '未知艺术家');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-vocal', '平行四界Vocal Collection', '平行四界vocal collection');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, track, disc, duration)
      VALUES ('sg-unknown-local', 'al-vocal', 'ar-unknown-local', '05 女孩你为何踮脚尖', '05 女孩你为何踮脚尖', 0, 1, 295);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-multi-local', '海伊', '海伊');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-quad-x2', '平行四界Quadimension X-2', '平行四界quadimension x-2');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, track, disc, duration)
      VALUES ('sg-multi-local', 'al-quad-x2', 'ar-multi-local', '3.调味家', '3.调味家', 3, 1, 213);
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-across-local', '塞壬唱片-MSR, David Lin, Erik Castro, 金小鱼', '塞壬唱片-msr, david lin, erik castro, 金小鱼');
    INSERT INTO albums (id, name, sort_name) VALUES ('al-across', 'Across the wind', 'across the wind');
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, track, disc, duration)
      VALUES ('sg-across-local', 'al-across', 'ar-across-local', 'Across the wind', 'Across the wind', 1, 1, 254);
  `);
  return sqlite;
}

function makeApp(sqlite: DatabaseSync) {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "admin", level: 3, enabled: 1, password: "x" });
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
  console.log("clone upsertMaster maps remote id to existing local song:");
  const sqlite = buildDb();
  const app = makeApp(sqlite);
  const upsert = await app.post("/edgesonic/clone/upsertMaster", {
    sourceKey: "src-a",
    artist: { id: "remote-ar", name: "JAY'ED, Ms.OOJA" },
    album: { id: "remote-al", name: "また君と" },
    song: { id: "remote-song", albumId: "remote-al", artistId: "remote-ar", title: "また君と", duration: 282 },
  });
  assert(upsert.status === 200, `upsert status 200 (got ${upsert.status})`);
  const upsertBody = await upsert.json() as any;
  assert(upsertBody.masterId === "sg-local", `remote song fuzzy-mapped to sg-local (got ${upsertBody.masterId})`);
  const remoteSong = sqlite.prepare("SELECT id FROM song_masters WHERE id='remote-song'").get() as any;
  assert(!remoteSong, "no duplicate song_master created with remote id");

  console.log("clone upsertStarred resolves remote song id:");
  const starred = await app.post("/edgesonic/clone/upsertStarred", {
    sourceKey: "src-a",
    userId: "admin",
    items: [{ id: "remote-song", type: "song" }],
  });
  assert(starred.status === 200, `starred status 200 (got ${starred.status})`);
  const ann = sqlite.prepare("SELECT starred FROM annotations WHERE user_id='admin' AND item_id='sg-local' AND item_type='song'").get() as any;
  assert(ann?.starred === 1, "starred row uses local song id");

  console.log("clone upsertPlaylist resolves remote song id and avoids missing-owner FK:");
  const playlist = await app.post("/edgesonic/clone/upsertPlaylist", {
    sourceKey: "src-a",
    playlist: { id: "pl-remote", name: "Iris", owner: "missing-upstream-user", public: false },
    entries: ["remote-song"],
  });
  assert(playlist.status === 200, `playlist status 200 (got ${playlist.status})`);
  const pl = sqlite.prepare("SELECT owner, song_count FROM playlists WHERE id='pl-remote'").get() as any;
  assert(pl?.owner === "admin", `missing owner fell back to admin (got ${pl?.owner})`);
  assert(pl?.song_count === 1, `playlist song_count=1 (got ${pl?.song_count})`);
  const ps = sqlite.prepare("SELECT song_master_id FROM playlist_songs WHERE playlist_id='pl-remote'").get() as any;
  assert(ps?.song_master_id === "sg-local", `playlist entry uses local song id (got ${ps?.song_master_id})`);

  console.log("clone upsertMaster merges soundtrack bonus tracks despite artist metadata drift:");
  const opus = await app.post("/edgesonic/clone/upsertMaster", {
    sourceKey: "src-a",
    artist: { id: "remote-opus-ar", name: "Sigono" },
    album: { id: "remote-opus-al", name: "OPUS: Echo of Starsong Complete Soundtrack" },
    song: {
      id: "remote-opus-river",
      albumId: "remote-opus-al",
      artistId: "remote-opus-ar",
      title: "-Bonus Track- River (Official Trailer #1 Edit)",
      track: 66,
      disc: 2,
      duration: 57,
    },
  });
  assert(opus.status === 200, `OPUS upsert status 200 (got ${opus.status})`);
  const opusBody = await opus.json() as any;
  assert(opusBody.masterId === "sg-opus-river", `soundtrack duplicate mapped to sg-opus-river (got ${opusBody.masterId})`);
  const opusDuplicate = sqlite.prepare("SELECT id FROM song_masters WHERE id='remote-opus-river'").get() as any;
  assert(!opusDuplicate, "no duplicate OPUS song_master created with remote id");

  console.log("clone upsertMaster merges localized unknown artist aliases:");
  const unknown = await app.post("/edgesonic/clone/upsertMaster", {
    sourceKey: "src-a",
    artist: { id: "remote-unknown-ar", name: "Unknown Artist" },
    album: { id: "remote-vocal-al", name: "平行四界Vocal Collection" },
    song: { id: "remote-unknown-song", albumId: "remote-vocal-al", artistId: "remote-unknown-ar", title: "05 女孩你为何踮脚尖", track: 5, duration: 296 },
  });
  assert(unknown.status === 200, `unknown artist upsert status 200 (got ${unknown.status})`);
  const unknownBody = await unknown.json() as any;
  assert(unknownBody.masterId === "sg-unknown-local", `unknown artist duplicate mapped to sg-unknown-local (got ${unknownBody.masterId})`);

  console.log("clone upsertMaster merges multi-artist subset metadata:");
  const multi = await app.post("/edgesonic/clone/upsertMaster", {
    sourceKey: "src-a",
    artist: { id: "remote-multi-ar", name: "星尘, 永夜, 海伊, 牧心, 苍穹, 诗岸, 赤羽" },
    album: { id: "remote-quad-al", name: "平行四界Quadimension X-2" },
    song: { id: "remote-multi-song", albumId: "remote-quad-al", artistId: "remote-multi-ar", title: "3.调味家", track: 3, duration: 214 },
  });
  assert(multi.status === 200, `multi artist upsert status 200 (got ${multi.status})`);
  const multiBody = await multi.json() as any;
  assert(multiBody.masterId === "sg-multi-local", `multi artist duplicate mapped to sg-multi-local (got ${multiBody.masterId})`);

  console.log("clone upsertMaster merges exact title/album near-duration duplicates despite incompatible artists:");
  const near = await app.post("/edgesonic/clone/upsertMaster", {
    sourceKey: "src-a",
    artist: { id: "remote-across-ar", name: "塞壬唱片-MSR;Gracie Van Brunt" },
    album: { id: "remote-across-al", name: "Across the wind" },
    song: { id: "remote-across-song", albumId: "remote-across-al", artistId: "remote-across-ar", title: "Across the wind", track: 1, duration: 254 },
  });
  assert(near.status === 200, `near-duration upsert status 200 (got ${near.status})`);
  const nearBody = await near.json() as any;
  assert(nearBody.masterId === "sg-across-local", `near-duration duplicate mapped to sg-across-local (got ${nearBody.masterId})`);

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
