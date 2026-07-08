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

// 055 — Subsonic 1.16.1 download / downloadMultiple endpoints. Split out of the
// old endpoints/files.ts so the storage/files.ts file can focus on R2 / WebDAV
// CRUD without dragging in the Subsonic XML response shape.
import { Hono } from "hono";
import type { Context } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { createQueries } from "../../db/queries";
import { parseStorageUri, getSourceCredentials } from "../../adapters/index";

export const downloadRoutes = new Hono();

const downloadHandler = async (c: Context): Promise<Response> => {
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
      const creds = await getSourceCredentials(env.DB, "webdav", env);
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
      const { createSubsonicAdapter } = await import("../../adapters/subsonic");
      const result = await createSubsonicAdapter(env.DB, {}, env).stream(instance.storage_uri);
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
};

const downloadMultipleHandler = async (c: Context): Promise<Response> => {
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
};

// ============================================================================
// Route registration — Subsonic clients hit both /rest/<name> and the legacy
// `.view` suffix; both GET and POST are valid per spec.
// ============================================================================
function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  const mw = permissionMiddleware("download");
  for (const p of [`/${path}`, `/${path}.view`]) {
    downloadRoutes.get(p, mw, handler);
    downloadRoutes.post(p, mw, handler);
  }
}

register("download", downloadHandler);
register("downloadMultiple", downloadMultipleHandler);
