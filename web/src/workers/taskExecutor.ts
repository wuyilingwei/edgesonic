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

// Wire shape — matches the `tasks[]` returned by /edgesonic/work/poll. Kept
// minimal here because the worker can only trust what the Worker handed it
// (any extra columns leaked from D1 are just ignored).
interface Task {
  id: string;
  taskType: "metadata" | "transcode" | "scrape";
  payload: Record<string, unknown>;
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
    const msg = e instanceof Error ? e.message : String(e);
    (self as unknown as Worker).postMessage({ ok: false, error: msg });
  }
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
  const meta = await parseBuffer(buf, {
    mimeType: headResp.headers.get("content-type") || undefined,
  }, { duration: true, skipCovers: true });

  // Flatten the compact wire shape that endpoints/tag/submit.ts (041) expects.
  // We strip the giant common.picture / native.* fields — they'd inflate the
  // result_json column past the 100KB cap in /work/submit.
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
      duration:    meta.format.duration ? Math.round(meta.format.duration) : 0,
      bitrate:     meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : 0,
      sampleRate:  meta.format.sampleRate || 0,
      channels:    meta.format.numberOfChannels || 0,
      container:   meta.format.container || "",
      codec:       meta.format.codec || "",
    },
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
