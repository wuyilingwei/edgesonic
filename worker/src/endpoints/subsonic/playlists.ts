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
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import { mapPlaylist, mapPlaylistDetail } from "../../types/subsonic";
import { permissionMiddleware, subsonicError } from "../../auth";
import type { User } from "../../types/entities";

export const playlistsRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({ _attributes: o as Record<string, string | number | boolean | undefined> });

// ============================================================================
// Multi-value param helper — Subsonic clients send repeated keys as either
// query params (?songId=A&songId=B) or form fields (POST).
// ============================================================================
async function readMulti(c: import("hono").Context, name: string): Promise<string[]> {
  const fromQuery = c.req.queries(name);
  if (fromQuery && fromQuery.length > 0) return fromQuery.filter((v) => v !== "");

  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody({ all: true });
      const raw = body[name];
      if (raw === undefined) return [];
      if (Array.isArray(raw)) return raw.map((v) => String(v)).filter((v) => v !== "");
      return [String(raw)].filter((v) => v !== "");
    } catch {
      return [];
    }
  }
  return [];
}

async function readField(c: import("hono").Context, name: string): Promise<string | undefined> {
  const fromQuery = c.req.query(name);
  if (fromQuery !== undefined) return fromQuery;
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      const raw = body[name];
      if (raw === undefined) return undefined;
      return Array.isArray(raw) ? String(raw[0]) : String(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

// ============================================================================
// /rest/getPlaylists — list playlists visible to the caller
// ============================================================================
const getPlaylistsHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const queries = createQueries(c.env.DB);
  // `username` param: admin may inspect another user's playlists.
  const username = c.req.query("username");
  const target = username && username !== user.username
    ? (user.level === 3 ? username : user.username)
    : user.username;

  const rows = await queries.getPlaylistsForUser(target);
  return c.text(
    subsonicOK({
      playlists: {
        playlist: rows.map((r) => attrs(mapPlaylist(r))),
      },
    }),
    200, XML
  );
};

// ============================================================================
// /rest/getPlaylist — playlist detail + entries
// ============================================================================
const getPlaylistHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const id = c.req.query("id");
  if (!id) return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);

  const queries = createQueries(c.env.DB);
  const playlist = await queries.getPlaylistById(id);
  if (!playlist) return c.text(subsonicError(70, "Playlist not found"), 404, XML);

  // Visibility: owner OR public OR admin
  if (playlist.owner !== user.username && !playlist.public && user.level !== 3) {
    return c.text(subsonicError(50, "Not authorized to view this playlist"), 403, XML);
  }

  const songs = await queries.getPlaylistSongs(id);
  const detail = mapPlaylistDetail(playlist, songs);
  return c.text(
    subsonicOK({
      playlist: {
        _attributes: detail.attrs as unknown as Record<string, string | number | boolean | undefined>,
        entry: detail.entries.map((e) => attrs(e)),
      },
    }),
    200, XML
  );
};

// ============================================================================
// /rest/createPlaylist
// - With `playlistId`: replace contents (clear + reinsert songIds in order)
// - With `name`: create new playlist owned by caller, optional songIds
// ============================================================================
const createPlaylistHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const playlistId = await readField(c, "playlistId");
  const name = await readField(c, "name");
  const songIds = await readMulti(c, "songId");

  const queries = createQueries(c.env.DB);

  if (playlistId) {
    const existing = await queries.getPlaylistById(playlistId);
    if (!existing) return c.text(subsonicError(70, "Playlist not found"), 404, XML);
    if (existing.owner !== user.username && user.level !== 3) {
      return c.text(subsonicError(50, "Not authorized to modify this playlist"), 403, XML);
    }
    await queries.replacePlaylistSongs(playlistId, songIds);
    if (name) {
      await queries.updatePlaylistMeta(playlistId, { name });
    }
    const updated = await queries.getPlaylistById(playlistId);
    const songs = await queries.getPlaylistSongs(playlistId);
    if (!updated) return c.text(subsonicError(70, "Playlist not found"), 404, XML);
    const detail = mapPlaylistDetail(updated, songs);
    return c.text(
      subsonicOK({
        playlist: {
          _attributes: detail.attrs as unknown as Record<string, string | number | boolean | undefined>,
          entry: detail.entries.map((e) => attrs(e)),
        },
      }),
      200, XML
    );
  }

  if (!name) {
    return c.text(subsonicError(10, "Required parameter 'name' or 'playlistId' missing"), 400, XML);
  }

  const newId = crypto.randomUUID().substring(0, 12);
  await queries.createPlaylist({ id: newId, name, owner: user.username, songIds });
  const created = await queries.getPlaylistById(newId);
  if (!created) return c.text(subsonicError(0, "Playlist creation failed"), 500, XML);
  const songs = await queries.getPlaylistSongs(newId);
  const detail = mapPlaylistDetail(created, songs);
  return c.text(
    subsonicOK({
      playlist: {
        _attributes: detail.attrs as unknown as Record<string, string | number | boolean | undefined>,
        entry: detail.entries.map((e) => attrs(e)),
      },
    }),
    200, XML
  );
};

// ============================================================================
// /rest/updatePlaylist — partial update on an existing playlist
// ============================================================================
const updatePlaylistHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const playlistId = await readField(c, "playlistId");
  if (!playlistId) return c.text(subsonicError(10, "Required parameter 'playlistId' missing"), 400, XML);

  const queries = createQueries(c.env.DB);
  const existing = await queries.getPlaylistById(playlistId);
  if (!existing) return c.text(subsonicError(70, "Playlist not found"), 404, XML);
  if (existing.owner !== user.username && user.level !== 3) {
    return c.text(subsonicError(50, "Not authorized to modify this playlist"), 403, XML);
  }

  const name = await readField(c, "name");
  const comment = await readField(c, "comment");
  const publicVal = bool(await readField(c, "public"));
  const songIdsToAdd = await readMulti(c, "songIdToAdd");
  const rawIndices = await readMulti(c, "songIndexToRemove");
  const indices = rawIndices
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0);

  await queries.updatePlaylistMeta(playlistId, {
    name: name ?? undefined,
    comment: comment === undefined ? undefined : (comment === "" ? null : comment),
    isPublic: publicVal,
  });
  if (indices.length > 0) {
    await queries.removeSongsFromPlaylist(playlistId, indices);
  }
  if (songIdsToAdd.length > 0) {
    await queries.addSongsToPlaylist(playlistId, songIdsToAdd);
  }

  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/deletePlaylist — owner or admin (level 3)
// ============================================================================
const deletePlaylistHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const id = await readField(c, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);

  const queries = createQueries(c.env.DB);
  const existing = await queries.getPlaylistById(id);
  if (!existing) return c.text(subsonicError(70, "Playlist not found"), 404, XML);
  if (existing.owner !== user.username && user.level !== 3) {
    return c.text(subsonicError(50, "Not authorized to delete this playlist"), 403, XML);
  }

  await queries.deletePlaylist(id);
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration — Subsonic clients hit both `/rest/<name>` and the
// `.view` legacy suffix. Each handler is bound to both forms × {GET, POST}.
// ============================================================================
function register(
  path: string,
  middleware: ReturnType<typeof permissionMiddleware> | null,
  handler: (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => Promise<Response>,
) {
  const paths = [`/${path}`, `/${path}.view`];
  for (const p of paths) {
    if (middleware) {
      playlistsRoutes.get(p, middleware, handler);
      playlistsRoutes.post(p, middleware, handler);
    } else {
      playlistsRoutes.get(p, handler);
      playlistsRoutes.post(p, handler);
    }
  }
}

// getPlaylists / getPlaylist are read-only; gated by browse via authMiddleware (Subsonic standard).
register("getPlaylists", null, getPlaylistsHandler);
register("getPlaylist", null, getPlaylistHandler);
register("createPlaylist", permissionMiddleware("manage_playlists"), createPlaylistHandler);
register("updatePlaylist", permissionMiddleware("manage_playlists"), updatePlaylistHandler);
register("deletePlaylist", permissionMiddleware("manage_playlists"), deletePlaylistHandler);
