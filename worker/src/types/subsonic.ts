import type { Artist, Album, SongMaster, Playlist, Bookmark, PlayQueue } from "./entities";

// 035 — Subset of `annotations` row used by Subsonic responses.
// All three mapXxx functions accept this as an optional 3rd arg so existing
// callers (037 detail maps, etc.) compile unchanged.
export interface AnnotationLite {
  starred: number;                  // 0|1
  starred_at: number | null;        // unix seconds
  rating: number | null;            // 1-5 or null
  play_count: number;
}

export interface SubsonicArtist {
  id: string; name: string; coverArt?: string;
  albumCount?: number;
  starred?: string;
  userRating?: number;
  playCount?: number;
}

export interface SubsonicAlbum {
  id: string; name: string; artist?: string; artistId?: string;
  coverArt?: string; songCount: number; duration: number;
  created: string; year?: number; genre?: string;
  starred?: string;
  userRating?: number;
  playCount?: number;
}

export interface SubsonicChild {
  id: string; parent: string; isDir: boolean;
  title: string; album?: string; artist?: string;
  track?: number; year?: number; genre?: string;
  coverArt?: string; size?: number; contentType?: string;
  suffix?: string; duration?: number; bitRate?: number;
  isVideo: boolean;
  starred?: string;
  userRating?: number;
  playCount?: number;
}

// 035 — Inject starred / userRating / playCount when an annotation row exists.
// Subsonic spec emits `starred` only when truly starred (uses starred_at ISO).
// Absent annotation → all three fields stay undefined (back-compat with 1.16.1).
function applyAnnotation<
  T extends { starred?: string; userRating?: number; playCount?: number },
>(obj: T, ann: AnnotationLite | undefined): T {
  if (!ann) return obj;
  if (ann.starred === 1 && ann.starred_at !== null) {
    obj.starred = formatISODate(ann.starred_at);
  }
  if (ann.rating !== null && ann.rating > 0) obj.userRating = ann.rating;
  if (ann.play_count > 0) obj.playCount = ann.play_count;
  return obj;
}

export function mapArtist(a: Artist, annotation?: AnnotationLite): SubsonicArtist {
  const obj: SubsonicArtist = {
    id: a.id, name: a.name,
    coverArt: a.image_r2_key ? `ar-${a.id}` : undefined,
  };
  return applyAnnotation(obj, annotation);
}

export function mapAlbum(a: Album, artistName?: string, annotation?: AnnotationLite): SubsonicAlbum {
  const obj: SubsonicAlbum = {
    id: a.id, name: a.name,
    artist: artistName ?? undefined,
    // Always advertise a coverArt id — getCoverArt resolves & caches on demand
    coverArt: a.id.startsWith("al-") ? a.id : `al-${a.id}`,
    songCount: a.song_count, duration: a.duration,
    created: formatISODate(a.created_at),
    year: a.year ?? undefined, genre: a.genre ?? undefined,
  };
  return applyAnnotation(obj, annotation);
}

export function mapSong(s: SongMaster, parentId: string, annotation?: AnnotationLite): SubsonicChild {
  const obj: SubsonicChild = {
    id: s.id, parent: parentId, isDir: false,
    title: s.title, album: parentId,
    track: s.track ?? undefined, genre: s.genre ?? undefined,
    coverArt: s.album_id.startsWith("al-") ? s.album_id : `al-${s.album_id}`,
    duration: s.duration ?? undefined, isVideo: false,
  };
  return applyAnnotation(obj, annotation);
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
