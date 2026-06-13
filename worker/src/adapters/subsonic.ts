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
import { parseStorageUri, getSourceCredentials } from "./index";
import { md5 } from "../utils/md5";

export interface SubsonicAdapterOptions {
  // Anti-loop chain (DESIGN.md §3.2): IDs of every EdgeSonic hop so far.
  // Our own INSTANCE_ID is appended before forwarding upstream.
  instanceId?: string;
  incomingChain?: string[];
}

// 068 — `env` is optional so legacy call sites still compile while we migrate
// them over. When provided, the password column may be a `v1:<base64url>` blob
// that's transparently decrypted via env.STORAGE_KEY (see adapters/index.ts).
export function createSubsonicAdapter(
  db: D1Database,
  opts: SubsonicAdapterOptions = {},
  env?: { STORAGE_KEY?: string },
): StorageAdapter {
  return {
    async stream(uri: string, range?: string): Promise<StreamResult> {
      const { path } = parseStorageUri(uri);
      const creds = await getSourceCredentials(db, "subsonic", env);
      if (!creds) {
        return { body: null, statusCode: 401, contentLength: null, contentType: "text/plain", acceptRanges: false };
      }

      const salt = generateSalt(6);
      const token = md5(creds.password + salt);
      const chain = [...(opts.incomingChain ?? []), ...(opts.instanceId ? [opts.instanceId] : [])];
      const sep = path.includes("?") ? "&" : "?";
      let fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${path}${sep}u=${encodeURIComponent(creds.username)}&t=${token}&s=${salt}&v=1.16.1&c=EdgeSonic`;
      if (chain.length > 0) {
        fullUrl += `&esChain=${encodeURIComponent(chain.join(","))}`;
      }

      const headers: Record<string, string> = {};
      if (range) headers["Range"] = range;
      if (chain.length > 0) headers["X-EdgeSonic-Chain"] = chain.join(",");

      const resp = await fetch(fullUrl, { headers });
      return {
        body: resp.body,
        statusCode: resp.status,
        contentLength: parseInt(resp.headers.get("Content-Length") || "0", 10) || null,
        contentType: resp.headers.get("Content-Type") || "application/octet-stream",
        acceptRanges: resp.headers.get("Accept-Ranges") === "bytes",
        contentRange: resp.headers.get("Content-Range"),
      };
    },
  };
}

function generateSalt(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let salt = "";
  for (let i = 0; i < len; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}
