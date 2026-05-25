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

import type { Artist, Album, SongMaster } from "./entities";

export interface SubsonicArtist {
  id: string; name: string; coverArt?: string;
  albumCount?: number; starred?: string; userRating?: number;
}

export interface SubsonicAlbum {
  id: string; name: string; artist?: string; artistId?: string;
  coverArt?: string; songCount: number; duration: number;
  created: string; year?: number; genre?: string;
  starred?: string; userRating?: number;
}

export interface SubsonicChild {
  id: string; parent: string; isDir: boolean;
  title: string; album?: string; artist?: string;
  track?: number; year?: number; genre?: string;
  coverArt?: string; size?: number; contentType?: string;
  suffix?: string; duration?: number; bitRate?: number;
  isVideo: boolean; starred?: string; userRating?: number;
}

export function mapArtist(a: Artist): SubsonicArtist {
  return {
    id: a.id, name: a.name,
    coverArt: a.image_r2_key ? `ar-${a.id}` : undefined,
  };
}

export function mapAlbum(a: Album, artistName?: string): SubsonicAlbum {
  return {
    id: a.id, name: a.name,
    artist: artistName ?? undefined,
    coverArt: a.cover_r2_key ? `al-${a.id}` : undefined,
    songCount: a.song_count, duration: a.duration,
    created: formatISODate(a.created_at),
    year: a.year ?? undefined, genre: a.genre ?? undefined,
  };
}

export function mapSong(s: SongMaster, parentId: string): SubsonicChild {
  return {
    id: s.id, parent: parentId, isDir: false,
    title: s.title, album: parentId,
    track: s.track ?? undefined, genre: s.genre ?? undefined,
    coverArt: `al-${s.album_id}`,
    duration: s.duration ?? undefined, isVideo: false,
  };
}

function formatISODate(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
