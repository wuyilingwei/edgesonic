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
        // 053 owns the real BrowserPoolEngine integration. 052 ships the
        // dispatch path + queue + UI surface; until 053 lands, transcode
        // tasks fail fast so the row goes to 'failed' and an admin sees it.
        throw new Error("transcode tasks are not handled by 052; see task 053");
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
