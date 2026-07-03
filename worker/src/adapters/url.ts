import type { StorageAdapter, StreamResult } from "./index";

export const urlAdapter: StorageAdapter = {
  // 089 S2 — URL sources are read-only; writing is not supported.
  async put(): Promise<void> {
    throw new Error("read-only source: url adapter does not support put");
  },

  async stream(uri: string, range?: string): Promise<StreamResult> {
    const url = uri.substring("url://".length);
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = range;

    const resp = await fetch(url, { headers });
    if (!resp.ok && resp.status !== 206) {
      return { body: null, statusCode: resp.status, contentLength: null, contentType: "application/octet-stream", acceptRanges: false };
    }

    return {
      body: resp.body,
      statusCode: resp.status,
      contentLength: parseInt(resp.headers.get("Content-Length") || "0", 10) || null,
      contentType: resp.headers.get("Content-Type") || "application/octet-stream",
      acceptRanges: resp.headers.get("Accept-Ranges") === "bytes",
    };
  },
};
