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

interface Env {
  MUSIC_BUCKET: R2Bucket;
  CLEANUP_TOKEN: string;
}

const PREFIX = "music/";
const KEEP_KEY = "music/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-cleanup-token") !== env.CLEANUP_TOKEN) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const deleteMode = url.searchParams.get("delete") === "1";
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const listing = await env.MUSIC_BUCKET.list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const object of listing.objects) {
        if (object.key !== KEEP_KEY) keys.push(object.key);
      }
      cursor = listing.truncated ? listing.cursor : undefined;
      pages++;
    } while (cursor);

    if (deleteMode) {
      for (let i = 0; i < keys.length; i += 100) {
        await env.MUSIC_BUCKET.delete(keys.slice(i, i + 100));
      }
    }

    return Response.json({
      ok: true,
      mode: deleteMode ? "delete" : "dry-run",
      prefix: PREFIX,
      kept: KEEP_KEY,
      count: keys.length,
      pages,
      keys,
    });
  },
};
