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

import type { Artist, Album, SongMaster, Playlist, Bookmark, PlayQueue } from "./entities";

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
    // Always advertise a coverArt id — getCoverArt resolves & caches on demand
    coverArt: a.id.startsWith("al-") ? a.id : `al-${a.id}`,
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
    coverArt: s.album_id.startsWith("al-") ? s.album_id : `al-${s.album_id}`,
    duration: s.duration ?? undefined, isVideo: false,
  };
}

function formatISODate(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  comment?: string;
  owner: string;
  public: boolean;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  coverArt?: string;
}

export function mapPlaylist(p: Playlist): SubsonicPlaylist {
  return {
    id: p.id,
    name: p.name,
    comment: p.comment ?? undefined,
    owner: p.owner,
    public: !!p.public,
    songCount: p.song_count,
    duration: p.duration,
    created: formatISODate(p.created_at),
    changed: formatISODate(p.updated_at),
    coverArt: p.cover_r2_key ? `pl-${p.id}` : undefined,
  };
}

// Playlist detail returns playlist attributes + entry[] (each entry mirrors mapSong).
export function mapPlaylistDetail(p: Playlist, songs: SongMaster[]) {
  return {
    attrs: mapPlaylist(p),
    entries: songs.map((s) => mapSong(s, s.album_id)),
  };
}

// 037 — Bookmarks + PlayQueue
export interface SubsonicBookmark {
  position: number;          // ms within the song
  username: string;
  comment?: string;
  created: string;           // ISO 8601
  changed: string;           // ISO 8601
}

export interface SubsonicPlayQueue {
  current?: string;          // song_master_id
  position: number;          // ms within current
  username: string;
  changed: string;           // ISO 8601
  changedBy?: string;        // client name
}

export function mapBookmark(b: Bookmark, username: string): SubsonicBookmark {
  return {
    position: b.position_ms,
    username,
    comment: b.comment ?? undefined,
    created: formatISODate(b.created_at),
    changed: formatISODate(b.updated_at),
  };
}

// Bookmark detail: bookmark attributes + single nested <entry> (song).
export function mapBookmarkDetail(b: Bookmark, username: string, song: SongMaster) {
  return {
    attrs: mapBookmark(b, username),
    entry: mapSong(song, song.album_id),
  };
}

export function mapPlayQueue(q: PlayQueue, username: string): SubsonicPlayQueue {
  return {
    current: q.current_id ?? undefined,
    position: q.position_ms,
    username,
    changed: formatISODate(q.updated_at),
    changedBy: q.changed_by ?? undefined,
  };
}

// PlayQueue detail: queue attributes + ordered entry[] (each entry mirrors mapSong).
export function mapPlayQueueDetail(q: PlayQueue, username: string, songs: SongMaster[]) {
  return {
    attrs: mapPlayQueue(q, username),
    entries: songs.map((s) => mapSong(s, s.album_id)),
  };
}
