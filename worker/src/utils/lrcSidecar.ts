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

import { parseStorageUri, type StreamResult } from "../adapters";
import { createR2Adapter } from "../adapters/r2";
import { createWebDAVAdapter } from "../adapters/webdav";

const LRC_MAX_BYTES = 100 * 1024; // 100 KB hard cap

// Replace the file extension of a storage_uri's path component with `lrc`.
// `webdav://src/Artist/Album/01 Track.flac` → `webdav://src/Artist/Album/01 Track.lrc`
// Files without an extension simply get `.lrc` appended (rare; harmless).
function toLrcUri(storageUri: string): string {
  const m = storageUri.match(/^([a-z]+:\/\/.*?)(\.[^\/.]+)$/i);
  if (m) return `${m[1]}.lrc`;
  return `${storageUri}.lrc`;
}

async function streamToCappedText(
  result: StreamResult,
  maxBytes: number,
): Promise<string | null> {
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
  const blob = new Blob(chunks);
  try {
    const text = await blob.text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// Read a sibling .lrc file for the given audio instance URI.
// Returns the trimmed LRC text or null on any failure / absence / overflow.
export async function fetchLrcSidecar(
  env: Env,
  storageUri: string,
): Promise<string | null> {
  const parsed = parseStorageUri(storageUri);
  if (parsed.scheme !== "r2" && parsed.scheme !== "webdav") return null;

  const lrcUri = toLrcUri(storageUri);

  // Pre-check size when the adapter exposes it cheaply. For R2 we can HEAD via
  // the bucket API; for WebDAV we'd need a PROPFIND which isn't worth a second
  // round-trip, so we just rely on the read-side cap.
  let result: StreamResult;
  try {
    if (parsed.scheme === "r2") {
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(lrcUri);
    } else {
      result = await createWebDAVAdapter(env.DB, env).stream(lrcUri);
    }
  } catch {
    return null;
  }

  if (result.statusCode === 404 || result.body === null) return null;
  if (result.statusCode >= 400) return null;

  // Trust contentLength when present to short-circuit oversized files before
  // touching the body; otherwise the read loop enforces the cap.
  if (result.contentLength !== null && result.contentLength > LRC_MAX_BYTES) {
    try { result.body?.cancel(); } catch { /* ignore */ }
    return null;
  }

  return streamToCappedText(result, LRC_MAX_BYTES);
}

// Scan-time importer: pull the sibling .lrc and, on hit, write it back to
// song_masters.lyrics. Only writes when the column is currently empty so we
// never overwrite a tag-written or externally-fetched value. Never throws.
export async function importLrcOnScan(
  db: D1Database,
  env: Env,
  storageUri: string,
  masterId: string,
): Promise<void> {
  try {
    const lrc = await fetchLrcSidecar(env, storageUri);
    if (!lrc) return;
    // Conditional UPDATE — lyrics IS NULL OR TRIM(lyrics) = ''. Avoids racing
    // a concurrent tag-write that may have populated the column between the
    // scan INSERT and this call.
    await db.prepare(
      `UPDATE song_masters
          SET lyrics = ?, updated_at = ?
        WHERE id = ? AND (lyrics IS NULL OR lyrics = '')`,
    ).bind(lrc, Math.floor(Date.now() / 1000), masterId).run();
  } catch {
    // Swallow: sidecar import is best-effort. A transient D1 / R2 / WebDAV
    // hiccup must not flip the scan_job to failed.
  }
}