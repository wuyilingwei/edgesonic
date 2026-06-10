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
import { createQueries } from "../db/queries";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { createSubsonicAdapter } from "../adapters/subsonic";
import type { StreamResult } from "../adapters/index";
import { subsonicError } from "../auth";
import { getFeature, parseChain } from "../utils/features";

export const mediaRoutes = new Hono();

mediaRoutes.get("/rest/stream", async (c) => {
  const id = c.req.query("id");
  const format = c.req.query("format") || "raw";
  const maxBitRate = parseInt(c.req.query("maxBitRate") || "0", 10);

  if (!id) return c.text(subsonicError(10, "Missing id parameter"), 400, { "Content-Type": "application/xml; charset=UTF-8" });
  const env = c.env as Env;

  const queries = createQueries(env.DB);
  const instances = await queries.getSongInstances(id);

  if (instances.length === 0) return c.text(subsonicError(70, "Song not found"), 404, { "Content-Type": "application/xml; charset=UTF-8" });

  let selected = instances[0];
  for (const inst of instances) {
    if (format !== "raw" && inst.suffix === format) { selected = inst; break; }
    if (inst.suffix === selected.suffix && (inst.bit_rate || 0) > (selected.bit_rate || 0)) selected = inst;
    if (inst.suffix === "flac" && selected.suffix !== "flac") selected = inst;
    if (inst.source_id === "local" && selected.source_id !== "local") selected = inst;
    if (maxBitRate > 0 && (inst.bit_rate || 0) <= maxBitRate && (selected.bit_rate || 0) > maxBitRate) selected = inst;
  }

  const parsed = parseStorageUri(selected.storage_uri);
  const range = c.req.header("Range") || undefined;
  let result: StreamResult;

  switch (parsed.scheme) {
    case "r2":
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(selected.storage_uri, range);
      break;
    case "url":
      result = await urlAdapter.stream(selected.storage_uri, range);
      break;
    case "webdav":
      result = await createWebDAVAdapter(env.DB).stream(selected.storage_uri, range);
      break;
    case "subsonic": {
      if (!(await getFeature(env, "enable_subsonic_upstream"))) {
        return c.text(subsonicError(50, "Subsonic upstream sources are disabled"), 403, { "Content-Type": "application/xml; charset=UTF-8" });
      }
      const incomingChain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
      result = await createSubsonicAdapter(env.DB, {
        instanceId: env.INSTANCE_ID,
        incomingChain,
      }).stream(selected.storage_uri, range);
      break;
    }
    default:
      return c.text(subsonicError(0, "Unsupported storage scheme"), 500, { "Content-Type": "application/xml; charset=UTF-8" });
  }

  if (!result.body || result.statusCode >= 400) {
    return c.body(null, result.statusCode as never);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  if (result.contentLength) headers.set("Content-Length", String(result.contentLength));
  if (result.acceptRanges) headers.set("Accept-Ranges", "bytes");

  return new Response(result.body, { status: result.statusCode, headers });
});

mediaRoutes.get("/rest/getCoverArt", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.body(null, 400 as never);

  const prefix = id.substring(0, 3);
  const entityId = id.substring(3);
  const queries = createQueries((c.env as Env).DB);
  const env = c.env as Env;

  let coverKey: string | null = null;
  if (prefix === "al-") {
    const album = await queries.getAlbum(entityId);
    coverKey = album?.cover_r2_key ?? null;
  } else if (prefix === "ar-") {
    const artist = await queries.getArtist(entityId);
    coverKey = artist?.image_r2_key ?? null;
  }

  if (!coverKey) return c.body(null, 404 as never);

  const object = await env.MUSIC_BUCKET.get(coverKey);
  if (!object) return c.body(null, 404 as never);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});
