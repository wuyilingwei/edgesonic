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
import { subsonicOK } from "../utils/xml";
import { mapArtist, mapAlbum, mapSong } from "../types/subsonic";

export const browsingRoutes = new Hono();

browsingRoutes.get("/rest/getArtists", async (c) => {
  const queries = createQueries((c.env as Env).DB);
  const artists = await queries.getArtists();

  return c.text(
    subsonicOK({ artists: { index: groupByLetter(artists.map(mapArtist)) } }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

browsingRoutes.get("/rest/getArtist", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const queries = createQueries((c.env as Env).DB);
  const artist = await queries.getArtist(id);
  if (!artist) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const albums = await queries.getAlbumsByArtist(id);
  return c.text(
    subsonicOK({
      artist: {
        _attributes: mapArtist(artist),
        album: albums.map((a) => mapAlbum(a, artist.name)),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

browsingRoutes.get("/rest/getAlbum", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const queries = createQueries((c.env as Env).DB);
  const album = await queries.getAlbum(id);
  if (!album) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const songs = await queries.getSongMastersByAlbum(id);
  return c.text(
    subsonicOK({
      album: {
        _attributes: mapAlbum(album),
        song: songs.map((s) => mapSong(s, album.id)),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

browsingRoutes.get("/rest/getSong", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const queries = createQueries((c.env as Env).DB);
  const song = await queries.getSongMaster(id);
  if (!song) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  return c.text(
    subsonicOK({ song: { _attributes: mapSong(song, song.album_id) } }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

browsingRoutes.get("/rest/getIndexes", async (c) => {
  const queries = createQueries((c.env as Env).DB);
  const indexes = await queries.getArtistIndexes();

  return c.text(
    subsonicOK({
      indexes: {
        index: indexes.map((g) => ({
          _attributes: { name: g.letter },
          artist: g.artists.map(mapArtist),
        })),
      },
    }),
    200,
    { "Content-Type": "application/xml; charset=UTF-8" }
  );
});

browsingRoutes.get("/rest/getMusicDirectory", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });

  const queries = createQueries((c.env as Env).DB);
  const album = await queries.getAlbum(id);
  if (album) {
    const songs = await queries.getSongMastersByAlbum(id);
    return c.text(
      subsonicOK({
        directory: {
          _attributes: { id: album.id, name: album.name },
          child: songs.map((s) => mapSong(s, album.id)),
        },
      }),
      200,
      { "Content-Type": "application/xml; charset=UTF-8" }
    );
  }

  const artist = await queries.getArtist(id);
  if (artist) {
    const albums = await queries.getAlbumsByArtist(id);
    return c.text(
      subsonicOK({
        directory: {
          _attributes: { id: artist.id, name: artist.name },
          child: albums.map((a) => ({
            _attributes: {
              id: a.id, parent: artist.id,
              isDir: "true", title: a.name,
              album: a.name, artist: artist.name,
              year: a.year ?? undefined,
              genre: a.genre ?? undefined,
              coverArt: a.cover_r2_key ? `al-${a.id}` : undefined,
              isVideo: "false",
            },
          })),
        },
      }),
      200,
      { "Content-Type": "application/xml; charset=UTF-8" }
    );
  }

  return c.text(subsonicOK({}), 200, { "Content-Type": "application/xml; charset=UTF-8" });
});

function groupByLetter(items: ReturnType<typeof mapArtist>[]) {
  const groups: Record<string, ReturnType<typeof mapArtist>[]> = {};
  for (const item of items) {
    const letter = item.name.charAt(0).toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(item);
  }
  return Object.entries(groups).map(([name, artist]) => ({
    _attributes: { name },
    artist,
  }));
}
