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

// ============================================================================
// ----------------------------------------------------------------------------
//   GET/POST /rest/getBookmarks(.view)        → list current user's bookmarks
//   GET/POST /rest/createBookmark(.view)      → upsert (id, position, comment?)
//   GET/POST /rest/deleteBookmark(.view)      → drop (id)
//   GET/POST /rest/getPlayQueue(.view)        → fetch saved play queue
//   GET/POST /rest/savePlayQueue(.view)       → save (id*, current?, position?)
// Last-write-wins semantics; no cross-device merge.
// ============================================================================

import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import {
  mapBookmark,
  mapSong,
  mapPlayQueue,
} from "../../types/subsonic";
import { subsonicError } from "../../auth";
import type { User, SongMaster } from "../../types/entities";

export const bookmarksRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// ============================================================================
// Parameter parsing — GET query and POST form bodies share semantics in the
// Subsonic API. Read the request body at most once and merge it with the URL
// query string into a single multi-valued map.
// ============================================================================
type ParamMap = Map<string, string[]>;

async function readParams(c: Context): Promise<ParamMap> {
  const map: ParamMap = new Map();

  const push = (k: string, v: string) => {
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  };

  // URL query (multi-valued)
  const url = new URL(c.req.url);
  url.searchParams.forEach((v, k) => push(k, v));

  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody({ all: true });
      for (const [k, raw] of Object.entries(body)) {
        if (raw === undefined || raw === null) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        for (const v of values) {
          if (typeof v === "string") push(k, v);
        }
      }
    } catch {
      // body wasn't form-encoded — silently ignore (matches Subsonic tolerance)
    }
  }

  return map;
}

function getFirst(p: ParamMap, name: string): string | undefined {
  const arr = p.get(name);
  return arr && arr.length > 0 ? arr[0] : undefined;
}

function getAll(p: ParamMap, name: string): string[] {
  return (p.get(name) ?? []).filter((v) => v !== "");
}

function parseIntOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// /rest/getBookmarks — return all bookmarks for the current user
// ============================================================================
const getBookmarksHandler = async (c: Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const queries = createQueries(c.env.DB);

  const bookmarks = await queries.getBookmarksByUser(user.username);
  if (bookmarks.length === 0) {
    return c.text(subsonicOK({ bookmarks: {} }), 200, XML);
  }

  // Resolve song metadata for each bookmark
  const ids = bookmarks.map((b) => b.song_master_id);
  const songs = await queries.getSongMastersByIds(ids);
  const songById = new Map<string, SongMaster>();
  for (const s of songs) songById.set(s.id, s);

  return c.text(
    subsonicOK({
      bookmarks: {
        bookmark: bookmarks
          .map((b) => {
            const song = songById.get(b.song_master_id);
            if (!song) return null; // orphan — skip
            return {
              _attributes: mapBookmark(b, user.username) as unknown as Record<
                string, string | number | boolean | undefined
              >,
              entry: attrs(mapSong(song, song.album_id)),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      },
    }),
    200, XML
  );
};

// ============================================================================
// /rest/createBookmark — upsert
//   Params: id (song_master_id), position (ms), comment?
// ============================================================================
const createBookmarkHandler = async (c: Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const params = await readParams(c);

  const id = getFirst(params, "id");
  const position = parseIntOrNull(getFirst(params, "position"));
  const comment = getFirst(params, "comment");

  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);
  if (position === null || position < 0) {
    return c.text(subsonicError(10, "Required parameter is missing or invalid: position"), 400, XML);
  }

  const queries = createQueries(c.env.DB);
  // Ensure target song exists (Subsonic returns 70 Not found if missing).
  const song = await queries.getSongMaster(id);
  if (!song) return c.text(subsonicError(70, "Song not found"), 404, XML);

  await queries.upsertBookmark({
    username: user.username,
    songMasterId: id,
    positionMs: position,
    comment: comment ?? null,
  });

  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/deleteBookmark — drop by song id
//   Params: id (song_master_id)
// ============================================================================
const deleteBookmarkHandler = async (c: Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const params = await readParams(c);

  const id = getFirst(params, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);

  const queries = createQueries(c.env.DB);
  await queries.deleteBookmark(user.username, id);
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/getPlayQueue — return current user's saved queue (empty if unset)
// ============================================================================
const getPlayQueueHandler = async (c: Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const queries = createQueries(c.env.DB);

  const row = await queries.getPlayQueue(user.username);
  if (!row) {
    return c.text(subsonicOK({ playQueue: {} }), 200, XML);
  }

  let songIds: string[] = [];
  try {
    const parsed = JSON.parse(row.song_ids);
    if (Array.isArray(parsed)) songIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    songIds = [];
  }

  const fetched = songIds.length > 0 ? await queries.getSongMastersByIds(songIds) : [];
  const songById = new Map<string, SongMaster>();
  for (const s of fetched) songById.set(s.id, s);
  // Preserve queue order (and drop ids whose song was deleted upstream).
  const ordered: SongMaster[] = [];
  for (const id of songIds) {
    const s = songById.get(id);
    if (s) ordered.push(s);
  }

  return c.text(
    subsonicOK({
      playQueue: {
        _attributes: mapPlayQueue(row, user.username) as unknown as Record<
          string, string | number | boolean | undefined
        >,
        entry: ordered.map((s) => attrs(mapSong(s, s.album_id))),
      },
    }),
    200, XML
  );
};

// ============================================================================
// /rest/savePlayQueue — upsert
//   Params: id (multi, queue order), current? (song id), position? (ms), c? (client)
// ============================================================================
const savePlayQueueHandler = async (c: Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const params = await readParams(c);

  const ids = getAll(params, "id");
  const current = getFirst(params, "current");
  const position = parseIntOrNull(getFirst(params, "position"));
  const clientName = getFirst(params, "c");        // Subsonic standard client name

  const queries = createQueries(c.env.DB);
  await queries.savePlayQueue({
    username: user.username,
    songIds: ids,
    currentId: current ?? null,
    positionMs: position ?? 0,
    changedBy: clientName ?? c.req.header("User-Agent") ?? null,
  });

  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration — Subsonic clients hit both `/rest/<name>` and the
// `.view` legacy suffix; both GET and POST are valid per spec.
// ============================================================================
function register(
  path: string,
  handler: (c: Context<{ Bindings: Env; Variables: { user: User } }>) => Promise<Response>,
) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    bookmarksRoutes.get(p, handler);
    bookmarksRoutes.post(p, handler);
  }
}

register("getBookmarks", getBookmarksHandler);
register("createBookmark", createBookmarkHandler);
register("deleteBookmark", deleteBookmarkHandler);
register("getPlayQueue", getPlayQueueHandler);
register("savePlayQueue", savePlayQueueHandler);
