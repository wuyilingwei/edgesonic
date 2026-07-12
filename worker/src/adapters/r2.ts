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
        // 138 — `bytes=0-` (open-ended from offset 0) is semantically the
        // whole file. Treat it as a non-range GET so R2 returns the complete
        // object in a single 200 response (avoids any R2 range-stream edge
        // behaviour that could stall the browser's demuxer after the metadata
        // block on files with large embedded PICTURE blocks).
        if (match && !(match[1] === "0" && match[2] === "")) {
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
