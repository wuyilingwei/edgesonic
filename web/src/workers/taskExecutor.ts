// ---------------------------------------------------------------------------
// Runs as a dedicated Worker (module type) instantiated by stores/workerPool.ts
// for each claimed task. Receives one task via postMessage, runs it, posts
// {ok, result}|{ok:false, error} back, terminates.
//
// Long-running tasks (transcode) emit periodic {progress:..} messages so the
// main thread can dispatch /work/heartbeat between phases. Short tasks
// (metadata, scrape) finish well within the default 60s claim TTL and don't
// need heartbeats.
//
// Why a Worker at all when most tasks are I/O bound? Because 041 already
// proved that `music-metadata` decode pegs the main thread for several
// hundred ms per file on slower hardware (FLAC + APIC bigger than 10MB). The
// player UI MUST stay responsive; offloading is the cheap insurance.

import { parseBuffer } from "music-metadata";
import { lyricsTagsToText, nativeLyricsFallback } from "../lib/metadata";

// Wire shape — matches the `tasks[]` returned by /edgesonic/work/poll. Kept
// minimal here because the worker can only trust what the Worker handed it
// (any extra columns leaked from D1 are just ignored).
interface Task {
  id: string;
  taskType: "metadata" | "transcode" | "scrape";
  payload: Record<string, unknown>;
}

// truncates again to 500 in workerPool.ts → /work/submit truncates again to
// 500 in work.ts. Doing it here too keeps each postMessage cheap.
const ERR_LIMIT = 500;
function clampMsg(s: string): string {
  return s.length > ERR_LIMIT ? s.slice(0, ERR_LIMIT) : s;
}

self.addEventListener("message", async (e: MessageEvent<Task>) => {
  const task = e.data;
  try {
    let result: unknown;
    switch (task.taskType) {
      case "metadata":
        result = await runMetadata(task.payload);
        break;
      case "transcode":
        result = await runTranscode(task.payload);
        break;
      case "scrape":
        result = await runScrape(task.payload);
        break;
      default:
        throw new Error(`unknown task_type: ${task.taskType}`);
    }
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (e) {
    const raw = e instanceof Error
      ? (e.message || e.toString())
      : String(e);
    (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(raw) });
  }
});

// import (e.g. @ffmpeg/ffmpeg) or an unhandled rejection inside a then-chain
// that escapes the handler above would only surface as an `ErrorEvent` on the
// main thread — which Chromium often delivers with an empty `.message` for
// cross-origin/module workers. The main thread would then fall back to the
// hard-coded "worker errored" string. We catch both here and convert them to
// the same {ok:false, error} wire shape the main thread already handles.
self.addEventListener("error", (e: ErrorEvent) => {
  const msg = e.message || (e.error instanceof Error ? e.error.message : "")
    || "worker fired error event (no message)";
  (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(msg) });
});

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  const msg = reason instanceof Error
    ? (reason.message || reason.toString())
    : (typeof reason === "string" ? reason : `unhandled rejection: ${String(reason)}`);
  (self as unknown as Worker).postMessage({ ok: false, error: clampMsg(msg) });
});

// ---------------------------------------------------------------------------
// metadata — fetch the first 512KB of the source URI, parseBuffer it, return
// the compact tag set that endpoints/tag/submit.ts expects.
// ---------------------------------------------------------------------------
async function runMetadata(payload: Record<string, unknown>): Promise<unknown> {
  const sourceUri = String(payload.sourceUri || "");
  const instanceId = String(payload.instanceId || "");
  if (!sourceUri) throw new Error("metadata task missing sourceUri");
  if (!instanceId) throw new Error("metadata task missing instanceId");

  // sourceUri is a logical EdgeSonic URI (r2://…, webdav://…, url://…). We
  // can't fetch those directly — but the /rest/stream endpoint resolves the
  // URI server-side using the same instanceId. To stay storage-agnostic we
  // request the first 512KB via stream which honours Range headers (023).
  // The session signing is added by the main thread before postMessage —
  // see stores/workerPool.ts buildStreamUrl().
  const streamUrl = String(payload.streamUrl || "");
  if (!streamUrl) throw new Error("metadata task missing streamUrl (main thread should populate)");

  // anywhere in the file — often AFTER the data chunk (which can be 70+ MB).
  // A 512KB head only covers the start; the ID3 block at the tail is missed.
  // Strategy: fetch head (2MB for large ID3v2 headers with artwork) + tail
  // (512KB for trailing id3/INFO chunks). Concatenate with a gap so
  // music-metadata sees both regions. For non-WAV the tail fetch is skipped
  // (FLAC/MP3/M4A tags are at the head).
  const isWav = (payload.suffix || "").toLowerCase() === "wav";
  const HEAD_BYTES = 2 * 1024 * 1024; // 2MB — covers large ID3v2 + APIC
  const TAIL_BYTES = 512 * 1024;      // 512KB — trailing id3/INFO chunk

  const headResp = await fetch(streamUrl, {
    headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
  });
  if (!headResp.ok && headResp.status !== 206 && headResp.status !== 200) {
    throw new Error(`stream fetch failed: HTTP ${headResp.status}`);
  }
  let buf = new Uint8Array(await headResp.arrayBuffer());

  const contentRange = headResp.headers.get("content-range");
  const rangeTotalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  const totalSize = rangeTotalMatch
    ? parseInt(rangeTotalMatch[1], 10)
    : (Number(payload.size) || 0);

  // music-metadata's WaveParser only reads from the head buffer, but the
  // ID3v2 parser inside it scans for "id3 " chunks which can be at the end.
  // We append the tail bytes to the head buffer with a zero gap so the parser
  // can find trailing chunks via offset arithmetic.
  if (isWav && totalSize > buf.length + TAIL_BYTES) {
    try {
      const tailStart = totalSize - TAIL_BYTES;
      const tailResp = await fetch(streamUrl, {
        headers: { Range: `bytes=${tailStart}-${totalSize - 1}` },
      });
      if (tailResp.ok || tailResp.status === 206) {
        const tailBuf = new Uint8Array(await tailResp.arrayBuffer());
        // Concatenate: head + gap (zeros) + tail. The gap is filled with zeros
        // so the WAV parser sees a valid (if padded) stream. music-metadata's
        // tokenizer will read chunk headers from both regions.
        const gap = totalSize - buf.length - tailBuf.length;
        if (gap > 0 && gap < 100 * 1024 * 1024) { // sanity: don't alloc >100MB
          const combined = new Uint8Array(buf.length + gap + tailBuf.length);
          combined.set(buf, 0);
          // gap region stays zero-filled
          combined.set(tailBuf, buf.length + gap);
          buf = combined;
        }
      }
    } catch { /* tail fetch optional — head alone still works for duration */ }
  }

  // 093e — parse WITH covers so we can extract the embedded album art and
  // ship it back to the worker for R2 storage + album.cover_r2_key update.
  // skipCovers was previously true, which left every album with cover_r2_key
  // NULL → getCoverArt 404 for the whole library.
  // and no defaultSampleDuration in track fragment header" when the moof
  // fragment is incomplete (we only fetched a head slice). Wrap in try/catch
  // and fallback to basic atom parsing for the title/artist/album tags.
  let meta;
  try {
    meta = await parseBuffer(buf, {
      mimeType: headResp.headers.get("content-type") || undefined,
      size: totalSize > buf.length ? totalSize : undefined,
    }, { duration: true, skipCovers: false });
  } catch (parseErr) {
    // fMP4 crash — try without duration (avoids reading sample tables)
    try {
      meta = await parseBuffer(buf, {
        mimeType: headResp.headers.get("content-type") || undefined,
        size: totalSize > buf.length ? totalSize : undefined,
      }, { duration: false, skipCovers: false });
    } catch {
      // Total failure — return minimal result with just the error
      throw new Error(`metadata parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }
  }

  // Extract first embedded picture (APIC for ID3, PICTURE for FLAC, etc).
  // Cap at 200KB so result_json stays under the column cap. If the picture is
  // bigger than 200KB we skip it — the album just stays coverless until an
  // admin curates one via the TagEditor cover slot.
  let coverData: string | null = null;
  let coverMime: string | null = null;
  const pic: { data?: Uint8Array; format?: string } | undefined =
    meta.common.picture?.[0] as { data?: Uint8Array; format?: string } | undefined;
  if (pic && pic.data) {
    const bytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayBuffer);
    if (bytes.byteLength > 0 && bytes.byteLength <= 200_000) {
      // Base64-encode without chunking (Node's Buffer is not in Worker scope;
      // use btoa on a binary string).
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      coverData = btoa(bin);
      coverMime = (pic.format || "image/jpeg").replace(/^image\//, "image/");
    }
  }

  // Flatten the compact wire shape that endpoints/tag/submit.ts (041) expects.
  // We strip the giant common.picture / native.* fields — they'd inflate the
  // result_json column past the 100KB cap in /work/submit. The cover goes in
  // a separate `cover` field (base64) so the worker can write it to R2.
  return {
    instanceId,
    tags: {
      title:       meta.common.title || "",
      artist:      meta.common.artist || "",
      album:       meta.common.album || "",
      albumArtist: meta.common.albumartist || "",
      genre:       (meta.common.genre || []).join(", "),
      year:        meta.common.year ? String(meta.common.year) : "",
      track:       meta.common.track?.no ? String(meta.common.track.no) : "",
      disc:        meta.common.disk?.no ? String(meta.common.disk.no) : "",
      // this; songs scanned via work_queue (the primary multi-format path,
      // 052a/052b) never got embedded lyrics into D1. lyricsTagsToText is
      // shared with the 041 local-scan path (web/src/lib/metadata.ts).
      lyrics:      lyricsTagsToText(meta.common.lyrics) || nativeLyricsFallback(meta.native) || "",
      duration:    meta.format.duration ? Math.round(meta.format.duration) : 0,
      bitrate:     meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : 0,
      sampleRate:  meta.format.sampleRate || 0,
      channels:    meta.format.numberOfChannels || 0,
      container:   meta.format.container || "",
      codec:       meta.format.codec || "",
    },
    // 093e — embedded cover art. Worker decodes base64, writes to
    // covers/al-{albumId}, and updates albums.cover_r2_key. null when
    // the file has no embedded picture or the picture exceeds 200KB.
    cover: coverData ? { data: coverData, mime: coverMime } : null,
  };
}

// ---------------------------------------------------------------------------
// transcode — pull the source bytes, run ffmpeg.wasm with the pre-built argv,
// POST the encoded body to the one-shot uploadUrl. The Worker treats the
// upload response as the source of truth: r2Key and size come back from
// /edgesonic/work/upload (so the row in work_queue.result_json carries the
// canonical R2 path, not whatever the browser claims).
//
// NOTE: ffmpeg.wasm v0.12 prefers crossOriginIsolation (SharedArrayBuffer +
// COOP/COEP). EdgeSonic does not enable those yet (task 054). On non-isolated
// pages ff.load() falls back to a slower single-thread build; if it errors
// at all, we surface the message and let /work/submit mark the task failed.
// ---------------------------------------------------------------------------
async function runTranscode(payload: Record<string, unknown>): Promise<unknown> {
  const sourceUri = String(payload.sourceUri || "");
  const uploadUrl = String(payload.uploadUrl || "");
  const outputSuffix = String(payload.outputSuffix || "");
  const ffmpegArgs = Array.isArray(payload.ffmpegArgs)
    ? (payload.ffmpegArgs as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!sourceUri) throw new Error("transcode task missing sourceUri");
  if (!uploadUrl) throw new Error("transcode task missing uploadUrl");
  if (!outputSuffix) throw new Error("transcode task missing outputSuffix");
  if (ffmpegArgs.length === 0) throw new Error("transcode task missing ffmpegArgs");

  // Dynamic import — keeps ffmpeg.wasm out of the page-load bundle; only
  // browsers that volunteer for the work pool pay the ~5MB download.
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ff = new FFmpeg();
  await ff.load();

  // Pull the whole source. The browser-pool engine hands us a same-origin
  // /rest/stream URL, so cookies / session auth ride along automatically.
  const resp = await fetch(sourceUri);
  if (!resp.ok) throw new Error(`source fetch failed: HTTP ${resp.status}`);
  const inputBuf = new Uint8Array(await resp.arrayBuffer());

  // ffmpeg.wasm exposes a virtual filesystem; input must be written before
  // the exec() call, and the argv we got from the Worker uses "pipe:0" /
  // "pipe:1" placeholders — patch them onto real virtual files so we can
  // read the output back with readFile().
  const inputName = "in.src";
  const outputName = "out." + outputSuffix;
  await ff.writeFile(inputName, inputBuf);
  const patchedArgs = ffmpegArgs.map((a) =>
    a === "pipe:0" ? inputName : a === "pipe:1" ? outputName : a,
  );

  await ff.exec(patchedArgs);
  const out = await ff.readFile(outputName);
  // readFile's type is Uint8Array | string (string only when an encoding is
  // passed, which we don't). Narrow defensively; if a future API drift hands
  // us a string we'd corrupt the upload, so fail loud instead.
  if (typeof out === "string") {
    throw new Error("ffmpeg readFile returned string; expected Uint8Array");
  }
  // Copy into a fresh Uint8Array backed by a standard ArrayBuffer so the type
  // satisfies BodyInit (which rejects Uint8Array<ArrayBufferLike> because
  // ArrayBufferLike may be SharedArrayBuffer). The copy is O(n) but ffmpeg
  // outputs are typically a few MB — negligible vs. the upload itself.
  const outBytes: Uint8Array<ArrayBuffer> = new Uint8Array(out);

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    body: outBytes,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!uploadResp.ok) {
    const body = await uploadResp.text().catch(() => "");
    throw new Error(`upload failed: HTTP ${uploadResp.status} ${body.slice(0, 200)}`);
  }
  const uploadJson = await uploadResp.json() as { r2Key?: string; size?: number };
  return {
    r2Key: uploadJson.r2Key ?? null,
    size: uploadJson.size ?? outBytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// scrape — generic third-party HTTP proxy. Worker fetches the URL with the
// caller-supplied headers, parses the response as JSON. Used by the metadata
// scrape pipeline (040) when CORS prevents the main thread from going direct.
// ---------------------------------------------------------------------------
async function runScrape(payload: Record<string, unknown>): Promise<unknown> {
  const url = String(payload.url || "");
  if (!url) throw new Error("scrape task missing url");
  const headers = (payload.headers && typeof payload.headers === "object")
    ? payload.headers as Record<string, string>
    : {};
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`scrape fetch failed: HTTP ${resp.status}`);
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("json")) return await resp.json();
  return { text: await resp.text() };
}

// Hint to TS that we're in a Worker scope (no DOM globals).
export {};
