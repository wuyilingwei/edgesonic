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

/**
 * Manual client-side audio cache on IndexedDB.
 *
 * HTTP cache cannot cover /rest/stream in production (R2 presign 302 skips
 * the Worker cache headers), so fully-downloaded track blobs are persisted
 * here and served back as blob URLs on later plays. Every operation degrades
 * to a no-op when IndexedDB is unavailable or over quota — playback must
 * never depend on the cache.
 *
 * Eviction policy: when the cache exceeds its configured cap, or the browser
 * storage quota is close to full, entries are dropped lowest-weight-first.
 * Weight blends play frequency and recency so oft-played, recently-heard
 * tracks survive while stale, rarely-played ones are reclaimed first.
 */

export interface AudioCacheEntryMeta {
  id: string;
  size: number;
  lastUsedAt: number;
  playCount: number;
  duration: number;
}

interface StoredTrack {
  blob: Blob;
  size: number;
  lastUsedAt: number;
  playCount: number;
  duration: number;
}

const DB_NAME = "edgesonic-audio-cache";
const STORE = "tracks";
const LAST_USED_INDEX = "by-lastUsedAt";
const MAX_MB_KEY = "edgesonic:audioCacheMaxMB";
const DEFAULT_MAX_MB = 2048;
// Weight blend across the three retention factors (must sum to 1):
//   freq      — how often the track is played (keep popular tracks)
//   recency   — how recently it was played (keep fresh tracks)
//   efficiency— bytes per second (keep space-efficient tracks; drop bulky
//               high-bitrate ones first when space is tight)
const W_FREQ = 0.5;
const W_RECENCY = 0.3;
const W_EFFICIENCY = 0.2;
// Neutral efficiency score for entries without duration metadata (legacy
// records or missing tags) so freq/recency alone decide their fate.
const EFFICIENCY_NEUTRAL = 0.5;
// Reclaim this fraction of the cap beyond the target after a quota write
// failure, so a single retry is not immediately re-throttled.
const QUOTA_RECLAIM_FRACTION = 0.25;
// Trigger proactive eviction when browser storage usage exceeds this ratio.
const QUOTA_PRESSURE_RATIO = 0.9;

export function audioCacheMaxBytes(): number {
  const raw = parseInt(localStorage.getItem(MAX_MB_KEY) ?? "", 10);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
  return mb * 1024 * 1024;
}

export function setAudioCacheMaxMb(mb: number): void {
  localStorage.setItem(MAX_MB_KEY, String(mb));
}

export function audioCacheMaxMb(): number {
  const raw = parseInt(localStorage.getItem(MAX_MB_KEY) ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_MB;
}

/**
 * Pure LRU fallback: ids to delete (oldest first) so total size fits maxBytes.
 * Used when play counts carry no signal (e.g. all equal) and as a baseline.
 */
export function planLruEviction(entries: AudioCacheEntryMeta[], maxBytes: number): string[] {
  const sorted = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let total = sorted.reduce((sum, e) => sum + e.size, 0);
  const evict: string[] = [];
  for (const entry of sorted) {
    if (total <= maxBytes) break;
    evict.push(entry.id);
    total -= entry.size;
  }
  return evict;
}

function normalise(values: number[]): number[] {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

/**
 * Pure weighted core: ids to delete (lowest weight first) so total size fits
 * maxBytes. Weight blends three retention factors, each normalised to [0,1]
 * with higher meaning "keep":
 *   freq      — playCount scaled to the cache's max
 *   recency   — lastUsedAt scaled to the most-recent timestamp
 *   efficiency— 1 - bytesPerSecond scaled to the cache's max bitrate, so a
 *               low-bitrate track (small bytes per second of audio) is kept
 *               and a bulky high-bitrate one is dropped first; entries with
 *               no duration fall back to a neutral 0.5.
 */
export function planWeightedEviction(
  entries: AudioCacheEntryMeta[],
  maxBytes: number,
): string[] {
  if (!entries.length) return [];
  const freq = normalise(entries.map((e) => e.playCount));
  const recency = normalise(entries.map((e) => e.lastUsedAt));
  const known = entries.filter((e) => e.duration > 0);
  const bytesPerSec = entries.map((e) => (e.duration > 0 ? e.size / e.duration : 0));
  const maxBps = Math.max(...bytesPerSec, 0);
  // Efficiency is only meaningful as a comparison. With fewer than two known
  // durations there is no signal, so every entry falls back to neutral.
  const effNorm: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (known.length < 2 || entries[i].duration <= 0 || maxBps <= 0) { effNorm.push(EFFICIENCY_NEUTRAL); continue; }
    effNorm.push(1 - bytesPerSec[i] / maxBps);
  }
  const weighted = entries.map((e, i) => ({
    id: e.id,
    size: e.size,
    score: W_FREQ * freq[i] + W_RECENCY * recency[i] + W_EFFICIENCY * effNorm[i],
  }));
  weighted.sort((a, b) => a.score - b.score);
  let total = weighted.reduce((sum, e) => sum + e.size, 0);
  const evict: string[] = [];
  for (const entry of weighted) {
    if (total <= maxBytes) break;
    evict.push(entry.id);
    total -= entry.size;
  }
  return evict;
}


let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 3);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE).createIndex(LAST_USED_INDEX, "lastUsedAt");
      }
      if (request.transaction) {
        const store = request.transaction.objectStore(STORE);
        const migrate = store.openCursor();
        migrate.onsuccess = () => {
          const cursor = migrate.result;
          if (!cursor) return;
          const value = cursor.value as Partial<StoredTrack>;
          const patch: Partial<StoredTrack> = {};
          if (typeof value.playCount !== "number") patch.playCount = 1;
          if (typeof value.duration !== "number") patch.duration = 0;
          if (Object.keys(patch).length) cursor.update({ ...value, ...patch });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function txnDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("tx error"));
  });
}

/** Fetch a cached track blob; refreshes lastUsedAt and bumps playCount on hit. */
export async function getCachedTrack(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const record = await new Promise<StoredTrack | undefined>((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result as StoredTrack | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!record?.blob || record.blob.size === 0) {
      await txnDone(tx);
      return null;
    }
    store.put(
      { ...record, lastUsedAt: Date.now(), playCount: (record.playCount ?? 0) + 1 },
      id,
    );
    await txnDone(tx);
    return record.blob;
  } catch {
    return null;
  }
}

async function listMetas(db: IDBDatabase): Promise<AudioCacheEntryMeta[]> {
  return new Promise((resolve, reject) => {
    const metas: AudioCacheEntryMeta[] = [];
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(metas); return; }
      const value = cursor.value as StoredTrack;
      metas.push({
        id: String(cursor.primaryKey),
        size: value.size ?? value.blob?.size ?? 0,
        lastUsedAt: value.lastUsedAt ?? 0,
        playCount: value.playCount ?? 0,
        duration: value.duration ?? 0,
      });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteIds(db: IDBDatabase, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const tx = db.transaction(STORE, "readwrite");
  for (const id of ids) tx.objectStore(STORE).delete(id);
  await txnDone(tx);
}

async function evictToFit(db: IDBDatabase, maxBytes: number): Promise<void> {
  const metas = await listMetas(db);
  const evict = planWeightedEviction(metas, maxBytes);
  await deleteIds(db, evict);
}

/** Proactively reclaim space when the browser storage quota is nearly full. */
async function maybeEvictForQuota(db: IDBDatabase): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  let estimate: StorageEstimate;
  try { estimate = await navigator.storage.estimate(); } catch { return; }
  if (!estimate.quota || estimate.usage == null) return;
  if (estimate.usage / estimate.quota < QUOTA_PRESSURE_RATIO) return;
  const metas = await listMetas(db);
  if (!metas.length) return;
  const reclaim = Math.max(1, Math.ceil(metas.length * 0.1));
  const evict = planWeightedEviction(metas, 0).slice(0, reclaim);
  await deleteIds(db, evict);
}

/** Persist a fully-downloaded track blob, evicting low-weight entries when over the cap or quota. */
export async function putCachedTrack(id: string, blob: Blob, durationSec = 0): Promise<void> {
  try {
    const db = await openDb();
    if (!db || blob.size === 0) return;
    const maxBytes = audioCacheMaxBytes();
    if (blob.size > maxBytes) return;

    const existing = await new Promise<StoredTrack | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as StoredTrack | undefined);
      req.onerror = () => reject(req.error);
      void txnDone(tx);
    }).catch(() => undefined);

    const record: StoredTrack = {
      blob,
      size: blob.size,
      lastUsedAt: Date.now(),
      playCount: (existing?.playCount ?? 0) + 1,
      duration: durationSec > 0 ? durationSec : (existing?.duration ?? 0),
    };

    await maybeEvictForQuota(db);

    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, id);
      await txnDone(tx);
    } catch {
      // Quota pressure even after the proactive pass: drop the lowest-weight
      // quarter of entries and retry the put once.
      const metas = await listMetas(db);
      const quarter = Math.max(1, Math.ceil(metas.length * QUOTA_RECLAIM_FRACTION));
      const evict = planWeightedEviction(metas, 0).slice(0, quarter);
      await deleteIds(db, evict);
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, id);
      await txnDone(tx);
    }
    await evictToFit(db, maxBytes);
  } catch { /* cache is best-effort */ }
}

export async function clearAudioCache(): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txnDone(tx);
    return true;
  } catch {
    return false;
  }
}

/** Drop a single entry (e.g. a blob that turned out unplayable). */
export async function deleteCachedTrack(id: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await txnDone(tx);
  } catch { /* best-effort */ }
}

export async function audioCacheStats(): Promise<{ count: number; bytes: number } | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const metas = await listMetas(db);
    return { count: metas.length, bytes: metas.reduce((sum, m) => sum + m.size, 0) };
  } catch {
    return null;
  }
}