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

export interface PrefetchTrack {
  id: string;
  title: string;
  artist: string;
  coverArt?: string;
}

export interface TrackLyricsPayload {
  structured?: string;
  lrc?: string;
}

export interface TrackPrefetchAuth {
  authFetch: (path: string, params?: Record<string, string | string[]>) => Promise<string>;
  coverArtUrl: (coverId: string, size?: number) => string;
  scope: string;
}

const MAX_CACHE_ENTRIES = 32;
const metadataCache = new Map<string, Promise<string>>();
const lyricsCache = new Map<string, Promise<TrackLyricsPayload>>();
const coverCache = new Map<string, Promise<void>>();

function extractXmlInner(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match ? match[1] : "";
}

function cacheKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;

  let promise: Promise<T>;
  promise = load().catch((error) => {
    if (cache.get(key) === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

export function getTrackMetadataXml(track: Pick<PrefetchTrack, "id">, auth: Pick<TrackPrefetchAuth, "authFetch" | "scope">): Promise<string> {
  return remember(metadataCache, cacheKey(auth.scope, track.id), () => auth.authFetch("getSong", { id: track.id }));
}

export function getTrackLyrics(track: PrefetchTrack, auth: Pick<TrackPrefetchAuth, "authFetch" | "scope">): Promise<TrackLyricsPayload> {
  return remember(lyricsCache, cacheKey(auth.scope, track.id), async () => {
    const xml = await auth.authFetch("getLyricsBySongId", { id: track.id });
    const structured = extractXmlInner(xml, "structuredLyrics");
    if (structured) return { structured };

    const fallback = await auth.authFetch("getLyrics", { artist: track.artist, title: track.title });
    const lrc = extractXmlInner(fallback, "lyrics");
    return lrc ? { lrc } : {};
  });
}

function preloadImage(url: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("cover preload failed"));
    image.src = url;
  });
}

function preloadCover(track: PrefetchTrack, auth: TrackPrefetchAuth, size: number): Promise<void> {
  if (!track.coverArt) return Promise.resolve();
  const url = auth.coverArtUrl(track.coverArt, size);
  return remember(coverCache, cacheKey(auth.scope, url), () => preloadImage(url));
}

export function preloadTrack(track: PrefetchTrack, auth: TrackPrefetchAuth): void {
  void getTrackMetadataXml(track, auth).catch(() => {});
  void getTrackLyrics(track, auth).catch(() => {});
  void preloadCover(track, auth, 96).catch(() => {});
  void preloadCover(track, auth, 512).catch(() => {});
}
