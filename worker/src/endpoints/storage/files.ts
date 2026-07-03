import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getSourceCredentials } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { createWebDAVAdapter } from "../../adapters/webdav";
import { urlAdapter } from "../../adapters/url";
import { createSubsonicAdapter } from "../../adapters/subsonic";

export const filesRoutes = new Hono();

// ── Upload (raw body stream — studio-style) ──────────────────────────────
// POST /rest/files/upload?name=file.mp3&source=r2|webdav&path=music
filesRoutes.post("/files/upload", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const name = c.req.query("name");
  const source = c.req.query("source") || "r2";
  const path = c.req.query("path") || "";

  const rawBody = c.req.raw.body;
  if (!rawBody || !name) {
    return c.json({ ok: false, error: "Missing file body or name" }, 400);
  }

  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  // Build R2 key: music/ is the base; path is a sub-path relative to music/
  const cleanPath = path.replace(/^music\/?/, "").replace(/\/+$/, "");
  const r2Key = "music/" + (cleanPath ? cleanPath + "/" : "") + name;

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const suffix = name.split(".").pop() || "bin";

  if (source === "webdav") {
    const creds = await getSourceCredentials(db, "webdav", env);
    if (!creds) return c.json({ ok: false, error: "No WebDAV source configured" }, 400);
    const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${r2Key.split("/").map(encodeURIComponent).join("/")}`;
    const resp = await fetch(fullUrl, {
      method: "PUT",
      headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`, "Content-Type": contentType },
      body: rawBody,
    });
    if (!resp.ok) return c.json({ ok: false, error: `WebDAV upload failed: ${resp.status}` }, 500);
  } else {
    await env.MUSIC_BUCKET.put(r2Key, rawBody, { httpMetadata: { contentType } });
  }

  // DB record chain
  const sourceId = source === "webdav"
    ? (await db.prepare("SELECT id FROM storage_sources WHERE type = 'webdav' AND enabled = 1 LIMIT 1").first<{ id: string }>())?.id || "webdav"
    : "r2-local";
  const storageUri = source === "webdav" ? `webdav://${sourceId}/${r2Key}` : `r2://${r2Key}`;
  const instanceId = crypto.randomUUID().substring(0, 12);
  const title = name.replace(/\.[^.]+$/, "");
  const masterId = crypto.randomUUID().substring(0, 12);

  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name) VALUES ('unknown-artist', 'Unknown Artist', 'unknown artist')"),
      db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name) VALUES ('uploads', 'Uploads', 'uploads')"),
      db.prepare("INSERT OR IGNORE INTO song_masters (id, album_id, artist_id, title, created_at, updated_at) VALUES (?, 'uploads', 'unknown-artist', ?, ?, ?)")
        .bind(masterId, title, now, now),
      db.prepare("INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(instanceId, masterId, sourceId, storageUri, suffix, contentType, 0, now, now),
    ]);
  } catch (e) {
    if (source !== "webdav") await env.MUSIC_BUCKET.delete(r2Key);
    return c.json({ ok: false, error: `DB insert failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  return c.json({ ok: true, key: r2Key, id: instanceId, storageUri });
});

// ── File operations (studio-style structured REST, no notes/color-labels) ──

// POST /rest/files/delete  body: { key: "music/file.mp3" }
filesRoutes.post("/files/delete", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string }>();
  const { key } = body;
  if (!key) return c.json({ ok: false, error: "Missing key" }, 400);

  const db = env.DB;
  await env.MUSIC_BUCKET.delete(key);

  // Cascade D1 cleanup
  const inst = await db.prepare("SELECT master_id FROM song_instances WHERE storage_uri = ?")
    .bind(`r2://${key}`).first<{ master_id: string }>();
  if (inst) {
    await db.prepare("DELETE FROM song_instances WHERE storage_uri = ?").bind(`r2://${key}`).run();
    const others = await db.prepare("SELECT COUNT(*) AS n FROM song_instances WHERE master_id = ?")
      .bind(inst.master_id).first<{ n: number }>();
    if (!others?.n) {
      const master = await db.prepare("SELECT album_id, artist_id FROM song_masters WHERE id = ?")
        .bind(inst.master_id).first<{ album_id: string; artist_id: string }>();
      await db.prepare("DELETE FROM song_masters WHERE id = ?").bind(inst.master_id).run();
      if (master) {
        await db.prepare("DELETE FROM albums WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = ?)")
          .bind(master.album_id, master.album_id).run();
        await db.prepare("DELETE FROM artists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = ? OR album_artist_id = ?)")
          .bind(master.artist_id, master.artist_id, master.artist_id).run();
      }
    }
  }
  return c.json({ ok: true });
});

// POST /rest/files/move  body: { key, dest }
filesRoutes.post("/files/move", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string; dest: string }>();
  const { key, dest } = body;
  if (!key || !dest) return c.json({ ok: false, error: "Missing key or dest" }, 400);

  const obj = await env.MUSIC_BUCKET.get(key);
  if (!obj) return c.json({ ok: false, error: "Source not found" }, 404);

  await env.MUSIC_BUCKET.put(dest, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  await env.MUSIC_BUCKET.delete(key);

  await env.DB.prepare("UPDATE song_instances SET storage_uri = ?, updated_at = ? WHERE storage_uri = ?")
    .bind(`r2://${dest}`, Math.floor(Date.now() / 1000), `r2://${key}`).run();

  return c.json({ ok: true });
});

// POST /rest/files/copy  body: { key, dest }
filesRoutes.post("/files/copy", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string; dest: string }>();
  const { key, dest } = body;
  if (!key || !dest) return c.json({ ok: false, error: "Missing key or dest" }, 400);

  const obj = await env.MUSIC_BUCKET.get(key);
  if (!obj) return c.json({ ok: false, error: "Source not found" }, 404);

  await env.MUSIC_BUCKET.put(dest, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  return c.json({ ok: true });
});

// 089 S2 — Cross-source file copy (byte-level copy between any two adapters).
//
// POST /rest/files/crossCopy  body: { srcUri, destSource, destPath }
//
//   srcUri     — Full storage URI of the source file:
//                  r2://music/album/track.mp3
//                  webdav://<sourceId>/path/track.mp3
//                  url://https://...
//                  subsonic://<sourceId>/rest/stream?id=...
//
//   destSource — 'r2' for the local R2 bucket, OR a storage_sources.id for
//                a remote source. Only r2 and webdav sources are writable;
//                url and subsonic always return an error.
//
//   destPath   — Relative path at the destination (e.g. "Music/album/track.mp3").
//                For R2 destinations `music/` is prepended automatically if not
//                already present. For WebDAV the path is relative to the
//                source's root (as stored in the adapter credentials).
//
// This endpoint copies bytes only — it does NOT insert records into the
// library. Whether scanned files are entered into the media library is
// controlled by the destination source's `mode` column ('library' | 'sync_only')
// and is evaluated at scan time, not copy time.
//
// Response: { ok: true, destUri } or { ok: false, error: "..." }
filesRoutes.post("/files/crossCopy", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ srcUri?: string; destSource?: string; destPath?: string }>();
  const { srcUri, destSource, destPath } = body;

  if (!srcUri || !destSource || !destPath) {
    return c.json({ ok: false, error: "Missing srcUri, destSource, or destPath" }, 400);
  }

  // ── 1. Resolve source read adapter ──────────────────────────────────────
  const colonIdx = srcUri.indexOf("://");
  if (colonIdx < 0) return c.json({ ok: false, error: "Invalid srcUri: missing scheme" }, 400);
  const srcScheme = srcUri.substring(0, colonIdx) as "r2" | "url" | "webdav" | "subsonic";

  let srcStream: { body: ReadableStream<Uint8Array> | null; statusCode: number; contentType: string };
  switch (srcScheme) {
    case "r2":
      srcStream = await createR2Adapter(env.MUSIC_BUCKET).stream(srcUri);
      break;
    case "webdav":
      srcStream = await createWebDAVAdapter(env.DB, env).stream(srcUri);
      break;
    case "url":
      srcStream = await urlAdapter.stream(srcUri);
      break;
    case "subsonic":
      srcStream = await createSubsonicAdapter(env.DB, {}, env).stream(srcUri);
      break;
    default:
      return c.json({ ok: false, error: `Unknown source scheme: ${srcScheme}` }, 400);
  }

  if (!srcStream.body || srcStream.statusCode >= 400) {
    return c.json({ ok: false, error: `Source stream failed with status ${srcStream.statusCode}` }, 502);
  }

  // ── 2. Resolve destination adapter + URI ────────────────────────────────
  let destUri: string;
  let destPut: ((uri: string, body: ReadableStream<Uint8Array>, contentType?: string) => Promise<void>) | null = null;

  if (destSource === "r2") {
    // Strip leading 'music/' to avoid double-prefix, then re-add it.
    const cleanPath = destPath.replace(/^music\/?/, "");
    const key = "music/" + cleanPath;
    destUri = `r2://${key}`;
    const adapter = createR2Adapter(env.MUSIC_BUCKET);
    destPut = adapter.put!.bind(adapter);
  } else {
    // destSource is a storage_sources.id
    const row = await env.DB.prepare(
      "SELECT id, type FROM storage_sources WHERE id = ? AND enabled = 1",
    ).bind(destSource).first<{ id: string; type: string }>();

    if (!row) {
      return c.json({ ok: false, error: `Destination source not found or disabled: ${destSource}` }, 404);
    }

    switch (row.type) {
      case "r2": {
        const key = "music/" + destPath.replace(/^music\/?/, "");
        destUri = `r2://${key}`;
        const adapter = createR2Adapter(env.MUSIC_BUCKET);
        destPut = adapter.put!.bind(adapter);
        break;
      }
      case "webdav": {
        destUri = `webdav://${row.id}/${destPath}`;
        const wdAdapter = createWebDAVAdapter(env.DB, env);
        destPut = wdAdapter.put!.bind(wdAdapter);
        break;
      }
      case "url":
        return c.json({ ok: false, error: "Destination source is read-only (url)" }, 400);
      case "subsonic":
        return c.json({ ok: false, error: "Destination source is read-only (subsonic)" }, 400);
      default:
        return c.json({ ok: false, error: `Unknown destination source type: ${row.type}` }, 400);
    }
  }

  // ── 3. Write bytes ───────────────────────────────────────────────────────
  try {
    await destPut(destUri, srcStream.body as ReadableStream<Uint8Array>, srcStream.contentType);
  } catch (e) {
    return c.json(
      { ok: false, error: `Write to destination failed: ${e instanceof Error ? e.message : String(e)}` },
      500,
    );
  }

  return c.json({ ok: true, destUri });
});

// 055 — download / downloadMultiple moved to subsonic/download.ts (they remain
// part of the Subsonic protocol surface at /rest/*; storage/files.ts owns the
// non-Subsonic R2 / WebDAV management endpoints only).
