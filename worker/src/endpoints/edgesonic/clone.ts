//
// The browser drives the clone (see web/src/views/Settings.vue "Clone
// Subsonic server" sub-block): it fetches metadata + bytes directly from
// the upstream Subsonic server and POSTs each item here to be persisted
// locally. Keeping the loop client-side avoids Worker CPU-time timeouts
// when the upstream library is large.
//
// All endpoints live under /edgesonic/clone/* and require:
//  1. authMiddleware (path prefix /edgesonic/ → web session only)
//  2. permissionMiddleware("manage_users") — super-admin only
//
// Persistence is INSERT OR IGNORE for entity tables (artists/albums/
// song_masters) so a re-clone is a no-op; annotations / playlists /
// users / credentials use UPSERT so re-cloning refreshes the local copy.

import { Hono } from "hono";
import { md5 } from "../../utils/md5";
import { permissionMiddleware, sha256 } from "../../auth";
import type { User } from "../../types/entities";

export const cloneRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

function signedUpstreamUrl(baseUrl: string, username: string, password: string, path: string, params?: Record<string, string>): string {
  const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
  const q = new URLSearchParams({
    u: username,
    t: md5(password + s),
    s,
    v: "1.16.1",
    c: "EdgeSonicCloneProxy",
    f: "json",
    ...(params || {}),
  });
  return `${baseUrl.replace(/\/+$/, "")}/rest/${path}?${q.toString()}`;
}

// CORS-safe clone proxy. The browser POSTs upstream credentials to the
// EdgeSonic worker; the worker performs the upstream fetch server-side and
// returns the raw response. This avoids browser CORS restrictions when the
// upstream Subsonic server doesn't emit Access-Control-Allow-Origin.
cloneRoutes.post("/clone/proxy", permissionMiddleware("manage_users"), async (c) => {
  const body = await c.req.json<{
    upstreamUrl?: string;
    username?: string;
    password?: string;
    path?: string;
    params?: Record<string, string>;
    binary?: boolean;
  }>().catch(() => ({} as {
    upstreamUrl?: string; username?: string; password?: string; path?: string; params?: Record<string, string>; binary?: boolean;
  }));
  if (!body.upstreamUrl || !body.username || !body.password || !body.path) {
    return c.json({ ok: false, error: "Missing upstreamUrl / username / password / path" }, 400);
  }
  const url = signedUpstreamUrl(body.upstreamUrl, body.username, body.password, body.path, body.params);
  const resp = await fetch(url);
  if (body.binary) {
    const ab = await resp.arrayBuffer();
    return new Response(ab, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream",
      },
    });
  }
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json; charset=UTF-8",
    },
  });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertMaster
// ---------------------------------------------------------------------------
// Body: { artist, album, song, albumArtist? }
//   artist:    { id, name, sortName?, imageUrl? }
//   album:     { id, name, sortName?, year?, genre?, coverUrl? }
//   song:      { id, albumId, artistId, albumArtistId?, title, sortTitle?,
//                track?, disc?, duration?, genre?, compilation?, lyrics? }
//  albumArtist: optional { id, name, sortName? }
//
// Behaviour:
//  * INSERT OR IGNORE artists (artist + optional albumArtist)
//  * INSERT OR IGNORE albums
//  * INSERT OR IGNORE song_masters
//  * If song_masters row already existed, UPDATE the nullable columns with
//   the upstream values (COALESCE keeps existing non-null values when the
//   upstream omits a field). This lets a re-clone backfill fields that
//   were empty on the first pass.
//
// Response: { ok: true, masterId }
cloneRoutes.post("/clone/upsertMaster", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    artist?: { id: string; name: string; sortName?: string | null };
    album?: { id: string; name: string; sortName?: string | null; year?: number | null; genre?: string | null };
    song?: {
      id: string; albumId: string; artistId: string; albumArtistId?: string | null;
      title: string; sortTitle?: string | null;
      track?: number | null; disc?: number | null;
      duration?: number | null; genre?: string | null;
      compilation?: number | null; lyrics?: string | null;
    };
    albumArtist?: { id: string; name: string; sortName?: string | null };
  }>();

  const { artist, album, song, albumArtist } = body;
  if (!artist || !album || !song) {
    return c.json({ ok: false, error: "Missing artist/album/song" }, 400);
  }
  if (!artist.id || !artist.name || !album.id || !album.name || !song.id || !song.title) {
    return c.json({ ok: false, error: "Missing required id/name fields" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    db.prepare(
      "INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(artist.id, artist.name, artist.sortName ?? artist.name.toLowerCase(), now, now),
  );

  if (albumArtist && albumArtist.id && albumArtist.id !== artist.id) {
    stmts.push(
      db.prepare(
        "INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(albumArtist.id, albumArtist.name, albumArtist.sortName ?? albumArtist.name.toLowerCase(), now, now),
    );
  }

  stmts.push(
    db.prepare(
      "INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(album.id, album.name, album.sortName ?? album.name.toLowerCase(), album.year ?? null, album.genre ?? null, now, now),
  );

  stmts.push(
    db.prepare(
      `INSERT OR IGNORE INTO song_masters
         (id, album_id, artist_id, album_artist_id, title, sort_title,
          track, disc, duration, genre, compilation, lyrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      song.id,
      song.albumId,
      song.artistId,
      song.albumArtistId ?? null,
      song.title,
      song.sortTitle ?? song.title.toLowerCase(),
      song.track ?? null,
      song.disc ?? null,
      song.duration ?? null,
      song.genre ?? null,
      song.compilation ?? 0,
      song.lyrics ?? null,
      now,
      now,
    ),
  );

  await db.batch(stmts);

  // Backfill album year/genre + song_masters nullable columns when the row
  // pre-existed (INSERT OR IGNORE skipped it). COALESCE preserves any local
  // non-null value so a richer local scan doesn't get clobbered by a thinner
  // upstream response.
  if (album.year !== undefined || album.genre !== undefined) {
    await db.prepare(
      "UPDATE albums SET year = COALESCE(?, year), genre = COALESCE(?, genre), updated_at = ? WHERE id = ?",
    ).bind(album.year ?? null, album.genre ?? null, now, album.id).run();
  }

  await db.prepare(
    `UPDATE song_masters SET
       album_artist_id = COALESCE(?, album_artist_id),
       track = COALESCE(?, track),
       disc = COALESCE(?, disc),
       duration = COALESCE(?, duration),
       genre = COALESCE(?, genre),
       compilation = CASE WHEN ? IS NOT NULL THEN ? ELSE compilation END,
       lyrics = COALESCE(?, lyrics),
       updated_at = ?
     WHERE id = ?`,
  ).bind(
    song.albumArtistId ?? null,
    song.track ?? null,
    song.disc ?? null,
    song.duration ?? null,
    song.genre ?? null,
    song.compilation ?? null,
    song.compilation ?? null,
    song.lyrics ?? null,
    now,
    song.id,
  ).run();

  return c.json({ ok: true, masterId: song.id });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertPlaylist
// ---------------------------------------------------------------------------
// Body: { playlist, entries }
//  playlist: { id, name, owner, public?, comment?, coverUrl? }
//   entries:  string[] — song_master ids in order
//
// Replaces local playlist rows + entries on each call (mirrors the
// replacePlaylistSongs query semantics). INSERT OR REPLACE the playlist
// header so re-cloning refreshes name/public/comment atomically.
cloneRoutes.post("/clone/upsertPlaylist", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    playlist?: {
      id: string; name: string; owner: string;
      public?: boolean | null; comment?: string | null;
    };
    entries?: string[];
  }>();

  const { playlist, entries } = body;
  if (!playlist || !playlist.id || !playlist.name || !playlist.owner) {
    return c.json({ ok: false, error: "Missing playlist fields" }, 400);
  }
  const songIds = Array.isArray(entries) ? entries.filter((s) => typeof s === "string") : [];

  const now = Math.floor(Date.now() / 1000);
  // Compute totals from existing song_masters so playlist headers stay
  // consistent (only entries that actually resolve locally are counted).
  let count = 0;
  let duration = 0;
  if (songIds.length > 0) {
    const BATCH = 80;
    const rows: { duration: number | null }[] = [];
    for (let i = 0; i < songIds.length; i += BATCH) {
      const batch = songIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(",");
      const result = await db.prepare(
        `SELECT duration FROM song_masters WHERE id IN (${placeholders})`,
      ).bind(...batch).all<{ duration: number | null }>();
      rows.push(...result.results);
    }
    count = rows.length;
    for (const r of rows) duration += r.duration ?? 0;
  }

  await db.batch([
    db.prepare(
      `INSERT OR REPLACE INTO playlists
         (id, name, owner, public, song_count, duration, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      playlist.id,
      playlist.name,
      playlist.owner,
      playlist.public ? 1 : 0,
      count,
      duration,
      playlist.comment ?? null,
      now,
      now,
    ),
    db.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").bind(playlist.id),
  ]);

  if (songIds.length > 0) {
    // Re-INSERT only the entries that have a matching song_master so a FK
    // failure doesn't abort the whole batch. Position is the index in the
    // upstream `entries` array (so the local order matches upstream even
    // when some songs were skipped).
    const insertStmts: D1PreparedStatement[] = [];
    const known = new Set<string>();
    const BATCH = 80;
    for (let i = 0; i < songIds.length; i += BATCH) {
      const batch = songIds.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(",");
      const result = await db.prepare(
        `SELECT id FROM song_masters WHERE id IN (${placeholders})`,
      ).bind(...batch).all<{ id: string }>();
      for (const r of result.results) known.add(r.id);
    }
    songIds.forEach((sid, i) => {
      if (!known.has(sid)) return;
      insertStmts.push(
        db.prepare(
          "INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)",
        ).bind(playlist.id, sid, i, now),
      );
    });
    if (insertStmts.length > 0) await db.batch(insertStmts);
    // Resync the header count to the rows we actually inserted.
    await db.prepare(
      "UPDATE playlists SET song_count = (SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?), updated_at = ? WHERE id = ?",
    ).bind(playlist.id, now, playlist.id).run();
  }

  return c.json({ ok: true, playlistId: playlist.id, inserted: count });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertStarred
// ---------------------------------------------------------------------------
// Body: { userId, items }
//  userId: local users.username to attribute the stars to
//  items: Array<{ id, type: 'song'|'album'|'artist', starredAt? }>
//
// Uses starItem() semantics: UPSERT annotations, set starred=1 + starred_at.
// We don't unstar items that are absent from the upstream list — a clone is
// additive by design so local-only stars survive.
cloneRoutes.post("/clone/upsertStarred", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    userId?: string;
    items?: Array<{ id: string; type: "song" | "album" | "artist"; starredAt?: number | null }>;
  }>();

  const userId = body.userId;
  const items = Array.isArray(body.items) ? body.items : [];
  if (!userId) {
    return c.json({ ok: false, error: "Missing userId" }, 400);
  }

  let applied = 0;
  for (const it of items) {
    if (!it.id || !it.type) continue;
    if (it.type !== "song" && it.type !== "album" && it.type !== "artist") continue;
    const now = it.starredAt ?? Math.floor(Date.now() / 1000);
    await db.prepare(
      `INSERT INTO annotations (user_id, item_id, item_type, play_count, starred, starred_at)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
         starred = 1,
         starred_at = excluded.starred_at`,
    ).bind(userId, it.id, it.type, now).run();
    applied++;
  }

  return c.json({ ok: true, applied });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/upsertUser
// ---------------------------------------------------------------------------
// Body: { user, credentials? }
//   user:      { username, masterPassword (already SHA-256 hashed upstream? no — plaintext),
//                level?, enabled? }
//  credentials: Array<{ password, label?, streamProxyStrategy? }> — Subsonic client
//                passwords to mirror into local subsonic_credentials.
//
// EdgeSonic stores master_password as SHA-256(password). The upstream
// getStarred/getUsers responses expose the password as plaintext (Subsonic
// spec requires it for token auth), so we hash here before INSERT. If the
// caller already hashed, set `passwordHashed: true` to skip hashing.
cloneRoutes.post("/clone/upsertUser", permissionMiddleware("manage_users"), async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    user?: {
      username: string;
      password: string;        // plaintext (or pre-hashed if passwordHashed=true)
      passwordHashed?: boolean;
      level?: number;
      enabled?: boolean | number;
    };
    credentials?: Array<{
      password: string;
      label?: string | null;
      streamProxyStrategy?: string | null;
    }>;
  }>();

  const { user, credentials } = body;
  if (!user || !user.username || !user.password) {
    return c.json({ ok: false, error: "Missing user fields" }, 400);
  }

  const level = typeof user.level === "number" ? Math.max(0, Math.min(3, user.level)) : 1;
  const enabledNum = typeof user.enabled === "number"
    ? (user.enabled ? 1 : 0)
    : (user.enabled === false ? 0 : 1);
  const masterPassword = user.passwordHashed
    ? user.password
    : await sha256(user.password);
  const now = Math.floor(Date.now() / 1000);

  await db.prepare(
    `INSERT OR REPLACE INTO users
       (username, master_password, level, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(user.username, masterPassword, level, enabledNum, now, now).run();

  let credsApplied = 0;
  if (Array.isArray(credentials)) {
    for (const cred of credentials) {
      if (!cred.password) continue;
      const strategy = cred.streamProxyStrategy || "always";
      if (!["always", "never", "r2_only", "webdav_only"].includes(strategy)) continue;
      const id = crypto.randomUUID().substring(0, 12);
      await db.prepare(
        "INSERT INTO subsonic_credentials (id, username, password, label, stream_proxy_strategy, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, user.username, cred.password, cred.label || "", strategy, now).run();
      credsApplied++;
    }
  }

  return c.json({ ok: true, username: user.username, credentialsApplied: credsApplied });
});

// ---------------------------------------------------------------------------
// POST /edgesonic/clone/ingestAudio
// ---------------------------------------------------------------------------
// Body: raw bytes (the upstream /rest/stream payload).
// Query: ?masterId=<song_master_id>&suffix=<ext>&contentType=<mime>&
//      &artist=<...>&album=<...>&filename=<...>&size=<bytes>
//
// Writes R2 key `music/{artist}/{album}/{filename}` and creates a
// song_instances row (source_type='original', source_id='r2-local',
// storage_uri=r2://music/...). Idempotent: if a song_instance with the
// same storage_uri already exists, the R2 put still happens (overwrite)
// but the D1 insert is skipped.
//
// Mirrors work_upload.ts shape (binary body, R2 put, song_instances
// register) but the caller is the browser, not a browser-pool worker, so
// there's no HMAC token — the session middleware + manage_users guard is
// the auth surface.
const MAX_INGEST_BYTES = 256 * 1024 * 1024;

cloneRoutes.post("/clone/ingestAudio", permissionMiddleware("manage_users"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const masterId = c.req.query("masterId") || "";
  const suffix = (c.req.query("suffix") || "").toLowerCase();
  const contentType = c.req.query("contentType") || "application/octet-stream";
  const artistDir = (c.req.query("artist") || "Unknown Artist").replace(/[\/]+/g, "_").trim() || "Unknown Artist";
  const albumDir = (c.req.query("album") || "Unknown Album").replace(/[\/]+/g, "_").trim() || "Unknown Album";
  const filename = (c.req.query("filename") || "").replace(/[\/]+/g, "_").trim();
  const declaredSize = parseInt(c.req.query("size") || "0", 10);

  if (!masterId || !filename) {
    return c.json({ ok: false, error: "Missing masterId or filename" }, 400);
  }

  // Verify the master exists so we don't write orphan bytes to R2.
  const master = await db.prepare("SELECT id FROM song_masters WHERE id = ?")
    .bind(masterId).first<{ id: string }>();
  if (!master) {
    return c.json({ ok: false, error: "song_master not found — upsertMaster first" }, 404);
  }

  const contentLength = parseInt(c.req.header("Content-Length") || "0", 10);
  if (contentLength && contentLength > MAX_INGEST_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    return c.json({ ok: false, error: "Empty body" }, 400);
  }
  if (buf.byteLength > MAX_INGEST_BYTES) {
    return c.json({ ok: false, error: "Payload too large" }, 413);
  }

  const r2Key = `music/${artistDir}/${albumDir}/${filename}`;
  await env.MUSIC_BUCKET.put(r2Key, buf, {
    httpMetadata: { contentType },
  });
  const storageUri = `r2://${r2Key}`;

  // Idempotent instance row: skip if one already points at this uri.
  const existing = await db.prepare(
    "SELECT id FROM song_instances WHERE storage_uri = ? AND master_id = ?",
  ).bind(storageUri, masterId).first<{ id: string }>();
  if (existing) {
    return c.json({ ok: true, r2Key, size: buf.byteLength, instanceId: existing.id, registered: false });
  }

  const now = Math.floor(Date.now() / 1000);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const instanceId = `si-clone-${rand}`;
  try {
    await db.prepare(
      `INSERT INTO song_instances
         (id, master_id, source_id, source_type, storage_uri, suffix, content_type,
          size, tag_scanned, created_at, updated_at)
       VALUES (?, ?, 'r2-local', 'original', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      instanceId,
      masterId,
      storageUri,
      suffix || extToSuffix(filename),
      contentType,
      declaredSize || buf.byteLength,
      now,
      now,
    ).run();
  } catch (e) {
    // FK / PK failure shouldn't fail the whole clone — R2 bytes are valid.
    console.error(`[clone/ingestAudio] instance registration failed:`, e);
    return c.json({ ok: true, r2Key, size: buf.byteLength, registered: false });
  }

  return c.json({ ok: true, r2Key, size: buf.byteLength, instanceId, registered: true });
});

function extToSuffix(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.substring(idx + 1).toLowerCase() : "";
}
