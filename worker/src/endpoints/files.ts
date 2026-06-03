// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { Hono } from "hono";
import { permissionMiddleware, subsonicError } from "../auth";
import { subsonicOK } from "../utils/xml";
import { createQueries } from "../db/queries";
import { parseStorageUri, getSourceCredentials } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";

export const filesRoutes = new Hono();

// Upload file to R2
filesRoutes.post("/rest/upload", permissionMiddleware("upload"), async (c) => {
  const env = c.env as Env;
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const target = formData.get("target") as string; // "r2" or "webdav"
  const path = formData.get("path") as string; // optional sub-path

  if (!file) {
    return c.text(subsonicError(0, "No file provided"), 400, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const fileName = file.name;
  const r2Key = `uploads/${path ? path.replace(/\/$/, "") + "/" : ""}${fileName}`;

  if (target === "webdav") {
    const creds = await getSourceCredentials(db, "webdav");
    if (!creds) {
      return c.text(subsonicError(0, "No WebDAV source configured"), 400, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
    const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${r2Key}`;
    const resp = await fetch(fullUrl, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file.stream(),
    });
    if (!resp.ok) {
      return c.text(subsonicError(0, `WebDAV upload failed: ${resp.status}`), 500, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
  } else {
    // Default: upload to R2
    await env.MUSIC_BUCKET.put(r2Key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
  }

  // Create song instance record
  const masterId = formData.get("master_id") as string;
  const sourceId = target === "webdav"
    ? (await db.prepare("SELECT id FROM storage_sources WHERE type = 'webdav' AND enabled = 1 LIMIT 1").first<{ id: string }>())?.id || "webdav"
    : "r2-local";
  const storageUri = target === "webdav" ? `webdav://${sourceId}/${r2Key}` : `r2://${r2Key}`;
  const suffix = fileName.split(".").pop() || "bin";

  const instanceId = crypto.randomUUID().substring(0, 12);

  await db.prepare(
    `INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, content_type, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(instanceId, masterId || instanceId, sourceId, storageUri, suffix, file.type, file.size, now, now).run();

  return c.text(
    subsonicOK({
      upload: {
        _attributes: {
          id: instanceId,
          key: r2Key,
          size: String(file.size),
          storageUri,
        },
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

// Download file (from any source)
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

  // Get the song title for a better filename
  try {
    const master = await queries.getSongMaster(instance.master_id);
    if (master) {
      fileName = `${master.title}.${instance.suffix}`;
    }
  } catch {}

  switch (parsed.scheme) {
    case "r2": {
      const object = await env.MUSIC_BUCKET.get(instance.storage_uri.substring("r2://".length));
      if (object) {
        body = object.body;
        contentType = object.httpMetadata?.contentType || contentType;
      }
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
        const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${parsed.path}`;
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

// Batch download (ZIP placeholder — returns list for frontend to iterate)
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
