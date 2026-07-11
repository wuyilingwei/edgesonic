import type { StorageAdapter, StreamResult } from "./index";

export function createR2Adapter(bucket: R2Bucket): StorageAdapter {
  return {
    // 089 S2 — Write a new object into the R2 bucket. The URI must be
    // `r2://<key>` where <key> is the full object key (e.g. `music/album/track.mp3`).
    async put(
      uri: string,
      body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
      contentType?: string,
    ): Promise<void> {
      const key = uri.substring("r2://".length);
      await bucket.put(key, body, {
        httpMetadata: { contentType: contentType || "application/octet-stream" },
      });
    },

    async stream(uri: string, range?: string): Promise<StreamResult> {
      const key = uri.substring("r2://".length);

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const endStr = match[2];
          const length = endStr ? parseInt(endStr, 10) - start + 1 : undefined;
          const rangeOpt: { offset: number; length?: number } = { offset: start };
          if (length !== undefined) rangeOpt.length = length;
          const object = await bucket.get(key, { range: rangeOpt });
          if (!object) return { body: null, statusCode: 404, contentLength: null, contentType: "application/octet-stream", acceptRanges: false };
          const total = object.size;
          const end = length ? Math.min(start + length - 1, total - 1) : total - 1;
          return {
            body: object.body,
            statusCode: 206,
            contentLength: end - start + 1,
            contentType: object.httpMetadata?.contentType || "application/octet-stream",
            acceptRanges: true,
            contentRange: `bytes ${start}-${end}/${total}`,
          };
        }
      }

      const object = await bucket.get(key);
      if (!object) return { body: null, statusCode: 404, contentLength: null, contentType: "application/octet-stream", acceptRanges: false };
      return {
        body: object.body,
        statusCode: 200,
        contentLength: object.size,
        contentType: object.httpMetadata?.contentType || "application/octet-stream",
        acceptRanges: true,
      };
    },
  };
}
