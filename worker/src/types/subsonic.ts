import type { Artist, Album, SongMaster, Playlist, Bookmark, PlayQueue, InternetRadioStation, Share, PodcastChannel, PodcastEpisode } from "./entities";

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
  albumId?: string; artistId?: string;
  track?: number; discNumber?: number; year?: number; genre?: string;
  coverArt?: string; size?: number; contentType?: string;
  suffix?: string; duration?: number; bitRate?: number;
  path?: string; created?: string; type?: string;
  isVideo: boolean;
  starred?: string;
  userRating?: number;
  playCount?: number;
}

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

// mapper picks them up when present. Before 107 `album` was set to the album
// ID (parentId), which broke every client that displays Child.album as text.
// queries.ts SongPhysical); clients gate playback on suffix/contentType/
// bitRate/size/path, so emit them whenever the row has them.
export function mapSong(
  s: SongMaster & {
    artist_name?: string | null; album_name?: string | null;
    inst_suffix?: string | null; inst_content_type?: string | null;
    inst_bit_rate?: number | null; inst_size?: number | null;
    inst_duration?: number | null; inst_storage_uri?: string | null;
  },
  parentId: string,
  annotation?: AnnotationLite,
): SubsonicChild {
  const obj: SubsonicChild = {
    id: s.id, parent: parentId, isDir: false,
    title: s.title,
    album: s.album_name ?? undefined,
    artist: s.artist_name ?? undefined,
    albumId: s.album_id,
    artistId: s.artist_id || undefined,
    track: s.track ?? undefined,
    discNumber: s.disc ?? undefined,
    genre: s.genre ?? undefined,
    coverArt: s.album_id.startsWith("al-") ? s.album_id : `al-${s.album_id}`,
    duration: s.duration ?? s.inst_duration ?? undefined,
    suffix: s.inst_suffix ?? undefined,
    contentType: s.inst_content_type ?? undefined,
    bitRate: s.inst_bit_rate ?? undefined,
    size: s.inst_size ?? undefined,
    path: pathFromStorageUri(s.inst_storage_uri),
    created: formatISODate(s.created_at),
    type: "music",
    isVideo: false,
  };
  return applyAnnotation(obj, annotation);
}

// Child.path — clients (DSub cache layout, Symfonium dedup) want a stable
// file-ish path. Strip the scheme + source-id prefix off the storage URI
// (`webdav://<sourceId>/a/b.flac` → `a/b.flac`); the remainder is opaque but
// stable, which is all the spec asks for.
function pathFromStorageUri(uri: string | null | undefined): string | undefined {
  if (!uri) return undefined;
  const m = /^[a-z0-9+.-]+:\/\/[^/]+\/(.+)$/i.exec(uri);
  return m ? m[1] : undefined;
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

// homepageUrl is emitted only when non-empty (back-compat with strict clients).
export interface SubsonicInternetRadioStation {
  id: string;
  name: string;
  streamUrl: string;
  homepageUrl?: string;
}

export function mapInternetRadioStation(r: InternetRadioStation): SubsonicInternetRadioStation {
  return {
    id: r.id,
    name: r.name,
    streamUrl: r.stream_url,
    homepageUrl: r.homepage_url ?? undefined,
  };
}

// lastVisited visitCount> + nested <entry> per shared song.
// The Subsonic spec expects `url` to be the absolute public URL of the share;
// we let the endpoint inject it based on the current request's origin since
// the DB row has no idea what hostname the worker is serving under.
export interface SubsonicShare {
  id: string;
  url: string;                       // absolute https://host/share/<id>
  description?: string;
  username: string;
  created: string;                   // ISO 8601
  expires?: string;                  // ISO 8601 (omitted when never expires)
  lastVisited?: string;              // ISO 8601 (omitted before first view)
  visitCount: number;
}

export function mapShare(s: Share, publicUrl: string): SubsonicShare {
  return {
    id: s.id,
    url: publicUrl,
    description: s.description ?? undefined,
    username: s.user_id,
    created: formatISODate(s.created_at),
    expires: s.expires_at !== null ? formatISODate(s.expires_at) : undefined,
    lastVisited: s.last_visited_at !== null ? formatISODate(s.last_visited_at) : undefined,
    visitCount: s.view_count,
  };
}

// Share detail: share attributes + ordered <entry> array (each entry mirrors mapSong).
export function mapShareDetail(s: Share, publicUrl: string, songs: SongMaster[]) {
  return {
    attrs: mapShare(s, publicUrl),
    entries: songs.map((song) => mapSong(song, song.album_id)),
  };
}

// ============================================================================
// ----------------------------------------------------------------------------
// Subsonic spec shapes (subsonic-rest-api-1.16.1.xsd):
//   <channel id url title description coverArt originalImageUrl status errorMessage>
//     <episode id streamId channelId title description publishDate status
//              duration bitRate size suffix contentType isDir=false isVideo=false />*
//   </channel>
//
// coverArt is `pc-{id}` whenever the channel carries an image_url; getCoverArt
// negotiates the actual asset on demand.
// ============================================================================

export interface SubsonicPodcastChannel {
  id: string;
  url: string;
  title?: string;
  description?: string;
  coverArt?: string;
  originalImageUrl?: string;
  status: string;                   // new / completed / error
  errorMessage?: string;
}

export interface SubsonicPodcastEpisode {
  id: string;
  streamId: string;                 // dual purpose: stream endpoint id
  channelId: string;
  title?: string;
  description?: string;
  publishDate?: string;             // ISO 8601
  status: string;                   // new / downloading / completed / error
  duration?: number;
  bitRate?: number;
  size?: number;
  suffix?: string;
  contentType?: string;
  coverArt?: string;
  isDir: boolean;
  isVideo: boolean;
}

export function mapPodcastChannel(c: PodcastChannel): SubsonicPodcastChannel {
  const hasImage = !!c.image_url;
  return {
    id: c.id,
    url: c.url,
    title: c.title ?? undefined,
    description: c.description ?? undefined,
    coverArt: hasImage ? `pc-${c.id}` : undefined,
    originalImageUrl: c.image_url ?? undefined,
    status: c.status,
    errorMessage: c.error_message ?? undefined,
  };
}

export function mapPodcastEpisode(
  e: PodcastEpisode,
  channel?: PodcastChannel,
): SubsonicPodcastEpisode {
  const audioSuffix = e.audio_url ? guessAudioSuffix(e.audio_url) : undefined;
  return {
    id: e.id,
    streamId: e.id,
    channelId: e.channel_id,
    title: e.title ?? undefined,
    description: e.description ?? undefined,
    publishDate: e.published_at !== null ? formatISODate(e.published_at) : undefined,
    status: e.status,
    duration: e.duration ?? undefined,
    bitRate: e.bit_rate ?? undefined,
    size: e.size ?? undefined,
    suffix: audioSuffix,
    contentType: contentTypeForSuffix(audioSuffix),
    coverArt: channel?.image_url ? `pc-${channel.id}` : undefined,
    isDir: false,
    isVideo: false,
  };
}

function guessAudioSuffix(url: string): string | undefined {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url);
  if (!m) return undefined;
  const s = m[1].toLowerCase();
  return ["mp3", "m4a", "ogg", "opus", "aac", "wav", "flac"].includes(s) ? s : undefined;
}

function contentTypeForSuffix(s: string | undefined): string | undefined {
  switch (s) {
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "aac":  return "audio/aac";
    case "ogg":  return "audio/ogg";
    case "opus": return "audio/opus";
    case "wav":  return "audio/wav";
    case "flac": return "audio/flac";
    default:     return undefined;
  }
}
