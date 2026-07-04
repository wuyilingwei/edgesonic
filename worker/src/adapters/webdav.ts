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

// 092 — Optional presign capability for WebDAV. Returns a UserInfo-embedded
// URL (`https://user:pass@host/path`) so the browser can fetch bytes
// directly from the WebDAV server, bypassing the Worker sub-request
// bandwidth pool. The browser's Range header is preserved across the 302.
//
// SECURITY: the credentials appear in the URL and will leak to browser
// history / Referer / WebDAV server logs. Operators should configure a
// dedicated read-only account on the WebDAV server for this path. EdgeSonic
// does not manage the WebDAV server's user accounts.
export interface WebDAVPresignResult {
  url: string;
}

export function createWebDAVAdapter(
  db: D1Database,
  // env kept for call-site compat; no longer used for decryption
  _env?: unknown,
): StorageAdapter & {
  presign(uri: string, rangeHeader?: string): Promise<WebDAVPresignResult | null>;
} {
  return {
    // 089 S2 — Write a body to WebDAV via HTTP PUT. Uses the same credential
    // resolution and path encoding as stream(). The URI must be
    // `webdav://<sourceId>/<relative-path>`.
    async put(
      uri: string,
      body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
      contentType?: string,
    ): Promise<void> {
      const { path } = parseStorageUri(uri);
      const creds = await getSourceCredentials(db, "webdav");
      if (!creds) throw new Error("WebDAV source not configured or disabled");
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${encodedPath}`;
      const resp = await fetch(fullUrl, {
        method: "PUT",
        headers: {
          Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
          "Content-Type": contentType || "application/octet-stream",
        },
        body: body as BodyInit,
      });
      if (!resp.ok) {
        throw new Error(`WebDAV PUT failed: ${resp.status} ${resp.statusText}`);
      }
    },

    async stream(uri: string, range?: string): Promise<StreamResult> {
      const { path } = parseStorageUri(uri);
      const creds = await getSourceCredentials(db, "webdav");
      if (!creds) {
        return { body: null, statusCode: 401, contentLength: null, contentType: "text/plain", acceptRanges: false };
      }

      // Percent-encode each segment — raw '#'/'?' in filenames would truncate the URL
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${encodedPath}`;
      const headers: Record<string, string> = {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
      };
      if (range) headers["Range"] = range;

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

    // 092 — Build a UserInfo-embedded WebDAV URL for browser-direct 302.
    // Returns null when the WebDAV source has no configured credentials
    // (caller falls back to in-Worker stream). The Range header is NOT
    // encoded into the URL — the browser carries it on the redirected
    // request natively.
    async presign(uri: string, _rangeHeader?: string): Promise<WebDAVPresignResult | null> {
      const { path } = parseStorageUri(uri);
      const creds = await getSourceCredentials(db, "webdav");
      if (!creds) return null;

      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const base = creds.baseUrl.replace(/\/$/, "");
      // RFC 3986: UserInfo credentials go between scheme and host.
      // `btoa` is URL-safe for ASCII credentials; for non-ASCII we'd need
      // encodeURIComponent on the raw bytes, but WebDAV accounts are
      // conventionally ASCII. We percent-encode any reserved char in
      // user/pass to be safe ('@', ':', '/' inside credentials would
      // break the URL otherwise).
      const encUser = encodeURIComponent(creds.username);
      const encPass = encodeURIComponent(creds.password);
      // Insert user:pass@ after the scheme://
      const m = base.match(/^(https?:\/\/)(.*)$/);
      if (!m) return null;
      const url = `${m[1]}${encUser}:${encPass}@${m[2]}/${encodedPath}`;
      return { url };
    },
  };
}
