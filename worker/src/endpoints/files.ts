import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../auth";
import { subsonicOK } from "../utils/xml";
import { createQueries } from "../db/queries";
import { parseStorageUri, getSourceCredentials } from "../adapters/index";

export const filesRoutes = new Hono();

// ── Upload (raw body stream — studio-style) ──────────────────────────────
// POST /rest/files/upload?name=file.mp3&source=r2|webdav&path=music
filesRoutes.post("/rest/files/upload", permissionMiddleware("upload"), async (c) => {
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
    const creds = await getSourceCredentials(db, "webdav");
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
filesRoutes.post("/rest/files/delete", permissionMiddleware("upload"), async (c) => {
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
filesRoutes.post("/rest/files/move", permissionMiddleware("upload"), async (c) => {
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
filesRoutes.post("/rest/files/copy", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const body = await c.req.json<{ key: string; dest: string }>();
  const { key, dest } = body;
  if (!key || !dest) return c.json({ ok: false, error: "Missing key or dest" }, 400);

  const obj = await env.MUSIC_BUCKET.get(key);
  if (!obj) return c.json({ ok: false, error: "Source not found" }, 404);

  await env.MUSIC_BUCKET.put(dest, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  return c.json({ ok: true });
});

// ── Download (unchanged) ─────────────────────────────────────────────────

filesRoutes.get("/rest/download", permissionMiddleware("download"), async (c) => {
  const id = c.req.query("id");
  if (!id) {
    return c.text(subsonicError(0, "Missing id parameter"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const env = c.env as Env;
  const queries = createQueries(env.DB);
  const instance = await queries.getSongInstance(id);

  if (!instance) {
    return c.text(subsonicError(70, "File not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const parsed = parseStorageUri(instance.storage_uri);

  let body: ReadableStream<Uint8Array> | null = null;
  let contentType = instance.content_type || "application/octet-stream";
  let fileName = `${id}.${instance.suffix}`;

  try {
    const master = await queries.getSongMaster(instance.master_id);
    if (master) fileName = `${master.title}.${instance.suffix}`;
  } catch {}

  switch (parsed.scheme) {
    case "r2": {
      const object = await env.MUSIC_BUCKET.get(instance.storage_uri.substring("r2://".length));
      if (object) { body = object.body; contentType = object.httpMetadata?.contentType || contentType; }
      break;
    }
    case "url": {
      const resp = await fetch(instance.storage_uri.substring("url://".length));
      if (resp.ok) body = resp.body!;
      break;
    }
    case "webdav": {
      const creds = await getSourceCredentials(env.DB, "webdav");
      if (creds) {
        const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${parsed.path.split("/").map(encodeURIComponent).join("/")}`;
        const resp = await fetch(fullUrl, {
          headers: { Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}` },
        });
        if (resp.ok) body = resp.body!;
      }
      break;
    }
    case "subsonic": {
      const { createSubsonicAdapter } = await import("../adapters/subsonic");
      const result = await createSubsonicAdapter(env.DB).stream(instance.storage_uri);
      body = result.body;
      break;
    }
  }

  if (!body) {
    return c.text(subsonicError(70, "File data not available"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const encodedFileName = encodeURIComponent(fileName);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedFileName}`,
      "Content-Length": String(instance.size || 0),
    },
  });
});

filesRoutes.get("/rest/downloadMultiple", permissionMiddleware("download"), async (c) => {
  const ids = c.req.query("ids");
  if (!ids) {
    return c.text(subsonicError(0, "Missing ids parameter"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }
  const idList = ids.split(",");
  const env = c.env as Env;
  const queries = createQueries(env.DB);

  const items: Array<{ id: string; name: string; suffix: string; size: number }> = [];
  for (const id of idList) {
    const instance = await queries.getSongInstance(id.trim());
    if (instance) {
      const master = await queries.getSongMaster(instance.master_id);
      items.push({
        id: instance.id,
        name: master?.title || instance.id,
        suffix: instance.suffix,
        size: instance.size || 0,
      });
    }
  }

  return c.text(
    subsonicOK({
      downloadList: {
        item: items.map((it) => ({
          _attributes: {
            id: it.id,
            name: it.name,
            suffix: it.suffix,
            size: String(it.size),
          },
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});
