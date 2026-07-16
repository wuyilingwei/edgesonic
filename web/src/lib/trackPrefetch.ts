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

import { runLowPriority } from "./requestBudget";

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

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

const MAX_CACHE_ENTRIES = 32;
const TTL_METADATA_MS = 5 * 60 * 1000; // 5 分钟
const TTL_LYRICS_MS = 10 * 60 * 1000; // 10 分钟
const TTL_COVER_MS = 60 * 60 * 1000; // 1 小时

const metadataCache = new Map<string, CacheEntry<Promise<string>>>();
const lyricsCache = new Map<string, CacheEntry<Promise<TrackLyricsPayload>>>();
const coverCache = new Map<string, CacheEntry<Promise<void>>>();

// 缓存统计
const cacheStats = {
  metadataHits: 0,
  metadataMisses: 0,
  lyricsHits: 0,
  lyricsMisses: 0,
  coverHits: 0,
  coverMisses: 0,
};

export function getCacheStats() {
  return { ...cacheStats };
}

export function resetCacheStats() {
  cacheStats.metadataHits = 0;
  cacheStats.metadataMisses = 0;
  cacheStats.lyricsHits = 0;
  cacheStats.lyricsMisses = 0;
  cacheStats.coverHits = 0;
  cacheStats.coverMisses = 0;
}

function isExpired<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.timestamp > entry.ttl;
}

function cleanExpiredEntries() {
  // 清理元数据缓存
  for (const [key, entry] of metadataCache.entries()) {
    if (isExpired(entry)) {
      metadataCache.delete(key);
    }
  }
  // 清理歌词缓存
  for (const [key, entry] of lyricsCache.entries()) {
    if (isExpired(entry)) {
      lyricsCache.delete(key);
    }
  }
  // 清理封面缓存
  for (const [key, entry] of coverCache.entries()) {
    if (isExpired(entry)) {
      coverCache.delete(key);
    }
  }
}

// 启动后台清理任务（1 分钟周期）
if (typeof globalThis !== "undefined") {
  const cleanupInterval = setInterval(cleanExpiredEntries, 60 * 1000);
  if (typeof globalThis.clearInterval !== "undefined") {
    // 存储清理定时器以备后续需要
    (globalThis as any).__trackPrefetchCleanupInterval = cleanupInterval;
  }
}

function extractXmlInner(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match ? match[1] : "";
}

function cacheKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}

function remember<T>(
  cache: Map<string, CacheEntry<Promise<T>>>,
  key: string,
  load: () => Promise<T>,
  ttl: number,
): Promise<T> {
  const existing = cache.get(key);
  if (existing && !isExpired(existing)) {
    // 命中有效缓存
    return existing.data;
  }

  let promise: Promise<T>;
  promise = load().catch((error) => {
    if (cache.get(key)?.data === promise) cache.delete(key);
    throw error;
  });
  const entry: CacheEntry<Promise<T>> = {
    data: promise,
    timestamp: Date.now(),
    ttl,
  };
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

export function getTrackMetadataXml(track: Pick<PrefetchTrack, "id">, auth: Pick<TrackPrefetchAuth, "authFetch" | "scope">): Promise<string> {
  const key = cacheKey(auth.scope, track.id);
  const entry = metadataCache.get(key);
  if (entry && !isExpired(entry)) {
    cacheStats.metadataHits++;
    return entry.data;
  }
  cacheStats.metadataMisses++;
  return remember(metadataCache, key, () => auth.authFetch("getSong", { id: track.id }), TTL_METADATA_MS);
}

export function getTrackLyrics(track: PrefetchTrack, auth: Pick<TrackPrefetchAuth, "authFetch" | "scope">): Promise<TrackLyricsPayload> {
  const key = cacheKey(auth.scope, track.id);
  const entry = lyricsCache.get(key);
  if (entry && !isExpired(entry)) {
    cacheStats.lyricsHits++;
    return entry.data;
  }
  cacheStats.lyricsMisses++;
  return remember(lyricsCache, key, async () => {
    const xml = await auth.authFetch("getLyricsBySongId", { id: track.id });
    const structured = extractXmlInner(xml, "structuredLyrics");
    if (structured) return { structured };

    const fallback = await auth.authFetch("getLyrics", { artist: track.artist, title: track.title });
    const lrc = extractXmlInner(fallback, "lyrics");
    return lrc ? { lrc } : {};
  }, TTL_LYRICS_MS);
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
  const key = cacheKey(auth.scope, url);
  const entry = coverCache.get(key);
  if (entry && !isExpired(entry)) {
    cacheStats.coverHits++;
    return entry.data;
  }
  cacheStats.coverMisses++;
  return remember(coverCache, key, () => preloadImage(url), TTL_COVER_MS);
}

export function preloadTrack(track: PrefetchTrack, auth: TrackPrefetchAuth): void {
  void runLowPriority(() => getTrackMetadataXml(track, auth)).catch(() => {});
  void runLowPriority(() => getTrackLyrics(track, auth)).catch(() => {});
  void runLowPriority(() => preloadCover(track, auth, 96)).catch(() => {});
  void runLowPriority(() => preloadCover(track, auth, 512)).catch(() => {});
}
