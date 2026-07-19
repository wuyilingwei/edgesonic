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

//
// Two entry points:
//  - fetchLrcSidecar(env, storageUri): read the bytes of a sibling .lrc file
//   next to the given audio instance. Returns the text content or null when
//   the file is absent / too large / scheme unsupported.
//  - importLrcOnScan(db, env, storageUri, masterId): fetch the sidecar and,
//   on hit, write it back to song_masters.lyrics (only when D1 lyrics is
//   currently empty, so we never clobber a tag-written or externally-fetched
//   value).
//
// Design notes:
//  - Only `r2://` and `webdav://` schemes are eligible. `url://` and
//   `subsonic://` carry no directory concept, so we short-circuit.
//  - 100 KB size cap guards against pathological .lrc files dragging the scan
//   or the getLyrics path. We trust contentLength when present; otherwise we
//   accumulate bytes from the stream and abort on overflow.
//  - All failures are swallowed: a missing .lrc is the common case, not an
//   error. The caller treats null as "no lyrics available".
//  - 0259: the sidecar reader now also recognizes `.ttml` and `.krc`. The
//   scan-time importer prefers the rich-format file when present and stores
//   its parsed payload in song_masters.lyrics_rich; the plain `.lrc` (if
//   also present) still fills `lyrics` for v1 clients.

import { parseStorageUri, type StreamResult } from "../adapters";
import { createR2Adapter } from "../adapters/r2";
import { createWebDAVAdapter } from "../adapters/webdav";
import {
  parseSidecarToRich,
  serializeRich,
  type RichLyrics,
} from "./richLyrics";

const LRC_MAX_BYTES = 100 * 1024; // 100 KB hard cap

// Sibling sidecar candidates, in priority order: rich formats first (so a
// .ttml wins over a stale .lrc), then the plain LRC fallback. Each entry
// is the target URI with the audio extension replaced by the sidecar ext.
const SIDECAR_EXTS = [".ttml", ".krc", ".lrc"];

// Replace the file extension of a storage_uri's path component with the
// given sidecar extension.
function toSidecarUri(storageUri: string, ext: string): string {
  const m = storageUri.match(/^([a-z][a-z0-9]*:\/\/.*?)(\.[^\/.]+)$/i);
  if (m) return `${m[1]}${ext}`;
  return `${storageUri}${ext}`;
}

async function streamToCappedBytes(
  result: StreamResult,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!result.body) return null;
  const reader = result.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Abort the read and bail. We don't want to keep buffering a
          // runaway file — drop everything we've read so the caller treats
          // this as "no lyrics" rather than a truncated blob.
          reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
  return out;
}

// Read a sibling .lrc file for the given audio instance URI.
// Returns the trimmed LRC text or null on any failure / absence / overflow.
export async function fetchLrcSidecar(
  env: Env,
  storageUri: string,
): Promise<string | null> {
  const text = await fetchSidecarBytes(env, storageUri, ".lrc");
  if (!text) return null;
  try {
    const s = new TextDecoder().decode(text).trim();
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

// Read a sibling rich-format sidecar (.ttml / .krc / enhanced .lrc) and
// return the parsed RichLyrics payload, or null when no rich sidecar is
// present or parsing fails. The plain .lrc fallback (parseLrcToRich) is
// NOT applied here — callers want the rich payload only when a real
// word-level source exists, so the plain-LRC path stays in the
// getLyricsBySongId handler.
export async function fetchSidecarRich(
  env: Env,
  storageUri: string,
): Promise<RichLyrics | null> {
  for (const ext of SIDECAR_EXTS) {
    const bytes = await fetchSidecarBytes(env, storageUri, ext);
    if (!bytes) continue;
    const name = storageUri.split("/").pop() || `track${ext}`;
    const rich = await parseSidecarToRich(name + ext, bytes);
    if (rich) return rich;
  }
  return null;
}

async function fetchSidecarBytes(
  env: Env,
  storageUri: string,
  ext: string,
): Promise<Uint8Array | null> {
  const parsed = parseStorageUri(storageUri);
  if (parsed.scheme !== "r2" && parsed.scheme !== "webdav") return null;

  const sidecarUri = toSidecarUri(storageUri, ext);

  let result: StreamResult;
  try {
    if (parsed.scheme === "r2") {
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(sidecarUri);
    } else {
      result = await createWebDAVAdapter(env.DB, env).stream(sidecarUri);
    }
  } catch {
    return null;
  }

  if (result.statusCode === 404 || result.body === null) return null;
  if (result.statusCode >= 400) return null;

  if (result.contentLength !== null && result.contentLength > LRC_MAX_BYTES) {
    try { result.body?.cancel(); } catch { /* ignore */ }
    return null;
  }

  return streamToCappedBytes(result, LRC_MAX_BYTES);
}

// Scan-time importer: pull the sibling .lrc and, on hit, write it back to
// song_masters.lyrics. Only writes when the column is currently empty so we
// never overwrite a tag-written or externally-fetched value. Also pulls a
// rich sidecar (.ttml / .krc / enhanced .lrc) and writes its JSON payload to
// song_masters.lyrics_rich when empty. Never throws.
export async function importLrcOnScan(
  db: D1Database,
  env: Env,
  storageUri: string,
  masterId: string,
): Promise<void> {
  try {
    const lrc = await fetchLrcSidecar(env, storageUri);
    if (lrc) {
      // Conditional UPDATE — lyrics IS NULL OR TRIM(lyrics) = ''. Avoids racing
      // a concurrent tag-write that may have populated the column between the
      // scan INSERT and this call.
      await db.prepare(
        `UPDATE song_masters
            SET lyrics = ?, updated_at = ?
          WHERE id = ? AND (lyrics IS NULL OR lyrics = '')`,
      ).bind(lrc, Math.floor(Date.now() / 1000), masterId).run();
    }
  } catch {
    // Swallow: sidecar import is best-effort. A transient D1 / R2 / WebDAV
    // hiccup must not flip the scan_job to failed.
  }
  try {
    const rich = await fetchSidecarRich(env, storageUri);
    if (rich) {
      const json = serializeRich(rich);
      await db.prepare(
        `UPDATE song_masters
            SET lyrics_rich = ?, updated_at = ?
          WHERE id = ? AND (lyrics_rich IS NULL OR lyrics_rich = '')`,
      ).bind(json, Math.floor(Date.now() / 1000), masterId).run();
    }
  } catch {
    // Swallow: rich sidecar import is best-effort.
  }
}
