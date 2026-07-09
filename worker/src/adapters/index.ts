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

export interface StorageAdapter {
  stream(uri: string, range?: string): Promise<StreamResult>;
  // 089 S2 — Optional write capability. r2 and webdav implement this; url and
  // subsonic are read-only and either leave it undefined or throw. Callers must
  // check for undefined and surface a meaningful error before calling.
  put?(
    uri: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
}

export interface StreamResult {
  body: ReadableStream<Uint8Array> | null;
  statusCode: number;
  contentLength: number | null;
  contentType: string;
  acceptRanges: boolean;
  // RFC 7233: a 206 without Content-Range is invalid — browsers reject the media
  contentRange?: string | null;
}

export interface StorageUri {
  scheme: "r2" | "url" | "webdav" | "subsonic" | "s3";
  sourceId: string;
  path: string;
}

export function parseStorageUri(uri: string): StorageUri {
  const colonIdx = uri.indexOf("://");
  const scheme = uri.substring(0, colonIdx) as StorageUri["scheme"];
  const rest = uri.substring(colonIdx + 3);

  if (scheme === "url") {
    return { scheme: "url", sourceId: "local", path: rest };
  }

  const slashIdx = rest.indexOf("/");
  const sourceId = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
  const path = slashIdx >= 0 ? rest.substring(slashIdx + 1) : "";

  return { scheme, sourceId, path };
}

interface SourceRow {
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

export async function getSourceCredentials(
  db: D1Database,
  scheme: "webdav" | "subsonic",
  // env kept for call-site compat; encryption removed (068 rolled back)
  _env?: unknown,
): Promise<{ username: string; password: string; baseUrl: string } | null> {
  const source = await db
    .prepare(
      "SELECT base_url, username, password, root_path FROM storage_sources WHERE type = ? AND enabled = 1 LIMIT 1",
    )
    .bind(scheme)
    .first<SourceRow>();

  if (!source) return null;
  const root = (source.root_path || "").replace(/^\/+|\/+$/g, "");
  return {
    username: source.username || "",
    password: source.password || "",
    baseUrl: source.base_url.replace(/\/+$/, "") + (root ? `/${root}` : ""),
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// For WebDAV presign: prefer presign_username/presign_password (read-only account)
// over the main credentials. Falls back to main credentials when presign_username is absent.
export async function getWebDAVPresignCredentials(
  db: D1Database,
  sourceId: string,
): Promise<{ username: string; password: string; baseUrl: string } | null> {
  const row = await db
    .prepare(
      "SELECT base_url, username, password, presign_username, presign_password, root_path FROM storage_sources WHERE id = ? AND type = 'webdav' AND enabled = 1",
    )
    .bind(sourceId)
    .first<{
      base_url: string;
      username: string | null;
      password: string | null;
      presign_username: string | null;
      presign_password: string | null;
      root_path: string | null;
    }>();
  if (!row) return null;
  const root = (row.root_path || "").replace(/^\/+|\/+$/g, "");
  const baseUrl = row.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
  // prefer presign_username if non-empty, else fall back to main credentials
  const username = row.presign_username?.trim() ? row.presign_username : (row.username || "");
  const password = row.presign_username?.trim() ? (row.presign_password || "") : (row.password || "");
  return { username, password, baseUrl };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

interface S3SourceRow {
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
  region: string | null;
}

/**
 * Look up an enabled s3 source by id and return a fully resolved S3Config.
 * Returns null when the source is missing, not type='s3', or disabled.
 */
export async function getS3Config(
  db: D1Database,
  sourceId: string,
): Promise<import("./s3").S3Config | null> {
  const row = await db
    .prepare(
      "SELECT base_url, username, password, root_path, region FROM storage_sources WHERE id = ? AND type = 's3' AND enabled = 1",
    )
    .bind(sourceId)
    .first<S3SourceRow>();

  if (!row) return null;

  const { parseS3RootPath } = await import("./s3");
  const { bucket, prefix } = parseS3RootPath(row.root_path || "");

  return {
    endpoint: row.base_url.replace(/\/+$/, ""),
    bucket,
    prefix,
    accessKeyId: row.username || "",
    secretAccessKey: row.password || "",
    region: row.region || "us-east-1",
  };
}
