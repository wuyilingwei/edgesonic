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
