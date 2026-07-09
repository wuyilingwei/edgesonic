// 052 — Browser worker pool: task executor (Web Worker entry).
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
import { lyricsTagsToText } from "../lib/metadata";

// Wire shape — matches the `tasks[]` returned by /edgesonic/work/poll. Kept
// minimal here because the worker can only trust what the Worker handed it
// (any extra columns leaked from D1 are just ignored).
interface Task {
  id: string;
  taskType: "metadata" | "transcode" | "scrape";
  payload: Record<string, unknown>;
}

// 078 — keep worker error reporting short and informative. The main thread
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

// 078 — top-level safety nets. Before this, a syntax error in the dynamic
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

// 116 — locate the first `moof` (movie fragment) box in an MP4 buffer.
// Returns the byte offset where that box STARTS (its 4-byte size field, i.e.
// 4 bytes before the "moof" 4CC), or -1 when no fragment is present. Used by
// the fMP4 parse fallback in runMetadata.
function firstMoofBoxStart(buf: Uint8Array): number {
  // 'm','o','o','f'
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x66) {
      return i - 4;
    }
  }
  return -1;
}

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

  // 512KB window — large enough for an ID3v2 header with embedded artwork
  // plus the first frame, small enough not to pull a 100MB FLAC end-to-end.
  // music-metadata handles partial inputs by reporting whatever tags it could
  // extract from the available bytes.
  const headResp = await fetch(streamUrl, {
    headers: { Range: "bytes=0-524287" },
  });
  if (!headResp.ok && headResp.status !== 206 && headResp.status !== 200) {
    throw new Error(`stream fetch failed: HTTP ${headResp.status}`);
  }
  const buf = new Uint8Array(await headResp.arrayBuffer());

  // 111 — WAV duration was coming back as ~3 seconds for multi-minute files.
  // Root cause: music-metadata's WaveParser clamps the "data" chunk length to
  // `tokenizer.fileInfo.size - position` when the declared chunk is bigger
  // than what's available — and parseBuffer(), given nothing but this 512KB
  // slice, sets fileInfo.size to the SLICE'S length (512KB), not the true
  // remote file size. It then computes duration from that clamped (tiny)
  // chunk length, landing on "however many seconds of PCM fit in 512KB"
  // (~3s at CD quality) regardless of the file's real length. Passing the
  // true size (Content-Range's total, falling back to the dispatch payload's
  // `size`) fixes this at the source for WAV and any other format whose
  // duration/bitrate math depends on tokenizer.fileInfo.size.
  const contentRange = headResp.headers.get("content-range");
  const rangeTotalMatch = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  const totalSize = rangeTotalMatch
    ? parseInt(rangeTotalMatch[1], 10)
    : (Number(payload.size) || 0);

  // 093e — parse WITH covers so we can extract the embedded album art and
  // ship it back to the worker for R2 storage + album.cover_r2_key update.
  // skipCovers was previously true, which left every album with cover_r2_key
  // NULL → getCoverArt 404 for the whole library.
  const mimeType = headResp.headers.get("content-type") || undefined;
  let meta;
  try {
    meta = await parseBuffer(buf, {
      mimeType,
      size: totalSize > buf.length ? totalSize : undefined,
    }, { duration: true, skipCovers: false });
  } catch (e) {
    // 116 — fragmented-MP4 fallback. music-metadata (≤11.13.0) throws
    // "Missing sampleDuration and no defaultSampleDuration in track fragment
    // header" while walking `moof` fragments of some fMP4 .m4a files — AFTER
    // it has already read the complete tag set (moov/udta/ilst, including
    // ©lyr lyrics) that physically precedes the first fragment. Verified on a
    // production sample: truncating the buffer just before the first `moof`
    // box lets the same parser return title/artist/album/lyrics cleanly.
    // The fallback is gated on actually finding a `moof` box (the fMP4
    // discriminator) rather than on the error message text, which is brittle
    // across library versions. Duration is intentionally not requested here —
    // fMP4 duration lives in the fragments we just cut off.
    const cut = firstMoofBoxStart(buf);
    if (cut <= 16) throw e; // not fragmented MP4 → not our case, propagate
    meta = await parseBuffer(buf.slice(0, cut), {
      mimeType,
      size: cut,
    }, { duration: false, skipCovers: false });
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
      // 109 — the browser worker pool never read common.lyrics at all before
      // this; songs scanned via work_queue (the primary multi-format path,
      // 052a/052b) never got embedded lyrics into D1. lyricsTagsToText is
      // shared with the 041 local-scan path (web/src/lib/metadata.ts).
      lyrics:      lyricsTagsToText(meta.common.lyrics) || "",
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
