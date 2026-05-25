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

export const urlAdapter: StorageAdapter = {
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
