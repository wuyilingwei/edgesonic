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

// old endpoints/files.ts so the storage/files.ts file can focus on R2 / WebDAV
// CRUD without dragging in the Subsonic XML response shape.
import { Hono } from "hono";
import type { Context } from "hono";
import { permissionMiddleware, subsonicError } from "../../auth";
import { subsonicOK } from "../../utils/xml";
import { createQueries } from "../../db/queries";
import { parseStorageUri } from "../../adapters/index";
import type { StreamResult } from "../../adapters/index";
import { createR2Adapter } from "../../adapters/r2";
import { urlAdapter } from "../../adapters/url";
import { createWebDAVAdapter } from "../../adapters/webdav";
import { createSubsonicAdapter } from "../../adapters/subsonic";
import { AUDIO_MAX_AGE_SEC, applyPrivateCache, etagMatches, instanceEtag } from "../../utils/httpCache";

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
  // Callers pass a song_masters id; resolve it to its top instance the way
  // streamHandler does. A raw 'si-' instance id is still accepted.
  const instance = id.startsWith("si-")
    ? await queries.getSongInstance(id)
    : (await queries.getSongInstances(id))[0] ?? null;

  if (!instance) {
    return c.text(subsonicError(70, "File not found"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const parsed = parseStorageUri(instance.storage_uri);
  const range = c.req.header("Range");

  let fileName = `${id}.${instance.suffix}`;
  try {
    const master = await queries.getSongMaster(instance.master_id);
    if (master) fileName = `${master.title}.${instance.suffix}`;
  } catch {}

  // Resolve through the storage adapters, exactly like streamHandler does, so
  // this endpoint inherits Range support and the upstream's real byte length
  // instead of re-deriving either from the database row.
  let result: StreamResult;
  switch (parsed.scheme) {
    case "r2":
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(instance.storage_uri, range);
      break;
    case "url":
      result = await urlAdapter.stream(instance.storage_uri, range);
      break;
    case "webdav":
      result = await createWebDAVAdapter(env.DB, env).stream(instance.storage_uri, range);
      break;
    case "s3": {
      const { getS3Config } = await import("../../adapters/index");
      const { createS3Adapter } = await import("../../adapters/s3");
      const s3config = await getS3Config(env.DB, parsed.sourceId);
      if (!s3config) {
        return c.text(subsonicError(70, "S3 source not found or disabled"), 404, {
          "Content-Type": "application/xml; charset=UTF-8",
        });
      }
      result = await createS3Adapter(s3config).stream(instance.storage_uri, range);
      break;
    }
    case "subsonic":
      result = await createSubsonicAdapter(env.DB, {}, env).stream(instance.storage_uri, range);
      break;
    default:
      return c.text(subsonicError(0, "Unsupported storage scheme"), 500, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
  }

  if (!result.body || result.statusCode >= 400) {
    return c.text(subsonicError(70, "File data not available"), 404, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const encodedFileName = encodeURIComponent(fileName);
  const headers = new Headers();
  headers.set("Content-Type", result.contentType || instance.content_type || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodedFileName}`);
  // Only advertise a length the upstream actually confirmed. Declaring a stale
  // size makes the client wait for bytes that never arrive.
  if (result.contentLength) headers.set("Content-Length", String(result.contentLength));
  if (result.acceptRanges) headers.set("Accept-Ranges", "bytes");
  if (result.contentRange) headers.set("Content-Range", result.contentRange);

  const etag = instanceEtag(instance);
  applyPrivateCache(headers, AUDIO_MAX_AGE_SEC, etag);
  // Only a full response may 304 here; a range request needs its own bytes.
  if (result.statusCode === 200 && etagMatches(c, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(result.body, { status: result.statusCode, headers });
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
  for (const rawId of idList) {
    const id = rawId.trim();
    // Same id-semantics fix as downloadHandler above.
    const instance = id.startsWith("si-")
      ? await queries.getSongInstance(id)
      : (await queries.getSongInstances(id))[0] ?? null;
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
