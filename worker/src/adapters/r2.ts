import type { StorageAdapter, StreamResult } from "./index";

export function createR2Adapter(bucket: R2Bucket): StorageAdapter {
  return {
    async stream(uri: string, range?: string): Promise<StreamResult> {
      const key = uri.substring("r2://".length);

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const endStr = match[2];
          const length = endStr ? parseInt(endStr, 10) - start + 1 : undefined;
          const object = await bucket.get(key, { range: { offset: start, length } });
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
