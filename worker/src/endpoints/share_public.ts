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

// 044 — Public share route, extracted out of subsonic/shares.ts during the 055
// API refactor. It sits OUTSIDE /rest/* so authMiddleware can't intercept it,
// and outside the new /tag /storage /edgesonic buckets too — anonymous visitors
// must be able to press play without any credentials.
import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { createSubsonicAdapter } from "../adapters/subsonic";
import { getFeature, parseChain } from "../utils/features";
import type { StreamResult } from "../adapters/index";

export const sharePublicRoutes = new Hono();

sharePublicRoutes.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const env = c.env as Env;
  const queries = createQueries(env.DB);

  const share = await queries.getShareById(id);
  if (!share) {
    return c.text("Share not found", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // Expiry check (unix seconds). `expires_at = NULL` means never expires.
  const now = Math.floor(Date.now() / 1000);
  if (share.expires_at !== null && share.expires_at < now) {
    return c.text("Share has expired", 410, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  const songs = await queries.getShareEntries(id);
  if (songs.length === 0) {
    return c.text("Share has no entries", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // v1 — single-song streaming. The first entry wins; multi-song shares act
  // as a playlist where extra entries are visible via getShares but only the
  // first is reachable through the public link. Clients with EdgeSonic
  // credentials can hit /rest/stream for the rest.
  const first = songs[0];
  const instances = await queries.getSongInstances(first.id);
  if (instances.length === 0) {
    return c.text("Shared song has no playable source", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // Same preference order as /rest/stream — prefer flac, then highest
  // bitrate, then local source.
  let selected = instances[0];
  for (const inst of instances) {
    if (inst.suffix === selected.suffix && (inst.bit_rate || 0) > (selected.bit_rate || 0)) selected = inst;
    if (inst.suffix === "flac" && selected.suffix !== "flac") selected = inst;
    if (inst.source_id === "local" && selected.source_id !== "local") selected = inst;
  }

  c.executionCtx?.waitUntil?.(queries.incrementShareView(id));

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
        return c.text("Subsonic upstream sources are disabled", 403, { "Content-Type": "text/plain; charset=UTF-8" });
      }
      const incomingChain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
      result = await createSubsonicAdapter(env.DB, {
        instanceId: env.INSTANCE_ID,
        incomingChain,
      }).stream(selected.storage_uri, range);
      break;
    }
    default:
      return c.text("Unsupported storage scheme", 500, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  if (!result.body || result.statusCode >= 400) {
    return c.body(null, result.statusCode as never);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  if (result.contentLength) headers.set("Content-Length", String(result.contentLength));
  if (result.acceptRanges) headers.set("Accept-Ranges", "bytes");
  if (result.contentRange) headers.set("Content-Range", result.contentRange);
  headers.set("X-EdgeSonic-Share", id);

  return new Response(result.body, { status: result.statusCode, headers });
});
