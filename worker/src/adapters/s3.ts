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

//
// Design decisions:
//  • Always path-style URL: {endpoint}/{bucket}/{key}
//   – universally supported by all S3-compatible servers
//   – required for MinIO when endpoint is an IP address
//   – avoids the virtual-hosted DNS problem with self-hosted servers
//  • SigV4 Authorization header (proxy mode, no presign in v1)
//  • UNSIGNED-PAYLOAD for both GET and PUT (safe over HTTPS)
//  • ListObjectsV2 XML API for scanning (no SDK dependency)

import type { StorageAdapter, StreamResult } from "./index";
import { buildAuthorizationHeader } from "../utils/sigv4";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface S3Config {
  endpoint: string;       // e.g. "https://minio.example.com:9000"
  bucket: string;         // S3 bucket name
  prefix: string;         // object key prefix within bucket (may be empty)
  accessKeyId: string;
  secretAccessKey: string;
  region: string;         // e.g. "us-east-1", "auto" (R2), any value for MinIO
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Parse root_path ("bucket" or "bucket/prefix") into its components.
 * A bare root_path with no slash means prefix="".
 */
export function parseS3RootPath(rootPath: string): { bucket: string; prefix: string } {
  const slashIdx = rootPath.indexOf("/");
  if (slashIdx < 0) return { bucket: rootPath, prefix: "" };
  return {
    bucket: rootPath.substring(0, slashIdx),
    prefix: rootPath.substring(slashIdx + 1),
  };
}

/**
 * Percent-encode each path segment individually (preserves slashes as separators).
 * Keeps the segment URL-safe without double-encoding existing slashes.
 */
function encodeObjectKey(key: string): string {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/**
 * Build the full path-style S3 URL for an object key.
 * Format: {endpoint}/{bucket}/{encodedKey}
 */
function objectUrl(config: S3Config, key: string): string {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  return `${endpoint}/${config.bucket}/${encodeObjectKey(key)}`;
}

// ---------------------------------------------------------------------------
// ListObjectsV2
// ---------------------------------------------------------------------------

export interface S3Object {
  key: string;              // full key within bucket (including prefix)
  size: number;
  etag: string | null;
  lastModified: number | null; // unix seconds
}

/**
 * List objects via ListObjectsV2 (single page, up to maxKeys).
 * Returns { objects, nextToken } where nextToken is null when no more pages.
 *
 * Caller is responsible for pagination — call repeatedly with nextToken
 * until it is null.
 */
export async function listS3Objects(
  config: S3Config,
  continuationToken?: string,
  maxKeys = 1000,
): Promise<{ objects: S3Object[]; nextToken: string | null }> {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  // Normalise prefix: strip leading slash, always end with "/" so listing
  // returns objects under the prefix (not the prefix itself).
  const prefix = config.prefix ? config.prefix.replace(/^\/?/, "").replace(/\/?$/, "/") : "";

  const params = new URLSearchParams({ "list-type": "2", "max-keys": String(maxKeys) });
  if (prefix) params.set("prefix", prefix);
  if (continuationToken) params.set("continuation-token", continuationToken);

  const url = new URL(`${endpoint}/${config.bucket}?${params.toString()}`);

  const { authorization, amzDate, contentSha256 } = await buildAuthorizationHeader({
    method: "GET",
    url,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
    payloadHash: "UNSIGNED-PAYLOAD",
  });

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": contentSha256,
      Host: url.host,
    },
  });

  if (!resp.ok) {
    throw new Error(`S3 ListObjectsV2 ${resp.status}: ${await resp.text()}`);
  }

  const xml = await resp.text();
  const objects = parseListObjects(xml);
  const nextToken = extractXmlTag(xml, "NextContinuationToken") ?? null;

  return { objects, nextToken };
}

// ---------------------------------------------------------------------------
// XML parsing helpers (no DOM, pure regex — safe for Workers)
// ---------------------------------------------------------------------------

function parseListObjects(xml: string): S3Object[] {
  const contents: S3Object[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;

  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1];
    const key = extractXmlTag(block, "Key") ?? "";
    const size = parseInt(extractXmlTag(block, "Size") ?? "0", 10);
    // ETags returned by S3 are double-quoted; strip them.
    const rawEtag = (extractXmlTag(block, "ETag") ?? "").replace(/"/g, "").trim();
    const etag = rawEtag || null;
    const lm = extractXmlTag(block, "LastModified");
    const lastModified = lm ? Math.floor(new Date(lm).getTime() / 1000) : null;

    contents.push({ key, size, etag, lastModified });
  }

  return contents;
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match ? match[1].trim() : undefined;
}

// ---------------------------------------------------------------------------
// StorageAdapter implementation
// ---------------------------------------------------------------------------

export function createS3Adapter(config: S3Config): StorageAdapter {
  return {
    /**
     * Stream an S3 object. uri format: "s3://<sourceId>/<objectKey>"
     * where objectKey is the path within the bucket (NOT including bucket name).
     * Range is forwarded as-is; presigning is NOT used (v1 proxy mode only).
     */
    async stream(uri: string, range?: string): Promise<StreamResult> {
      // Strip "s3://<sourceId>/" prefix to get the raw object key
      const s3PrefixLen = "s3://".length;
      const slashIdx = uri.indexOf("/", s3PrefixLen);
      const key = slashIdx >= 0 ? uri.substring(slashIdx + 1) : "";

      const url = new URL(objectUrl(config, key));

      // Sign the Range header if present so S3 includes it in the canonical request.
      const extraHeaders: Record<string, string> = {};
      if (range) extraHeaders["range"] = range;

      const { authorization, amzDate, contentSha256 } = await buildAuthorizationHeader({
        method: "GET",
        url,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        service: "s3",
        payloadHash: "UNSIGNED-PAYLOAD",
        extraHeaders: range ? extraHeaders : undefined,
      });

      const headers: Record<string, string> = {
        Authorization: authorization,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": contentSha256,
        Host: url.host,
      };
      if (range) headers["Range"] = range;

      const resp = await fetch(url.toString(), { headers });

      if (!resp.ok && resp.status !== 206) {
        return {
          body: null,
          statusCode: resp.status,
          contentLength: null,
          contentType: "application/octet-stream",
          acceptRanges: false,
        };
      }

      const contentLength = resp.headers.get("Content-Length");
      return {
        body: resp.body,
        statusCode: resp.status,
        contentLength: contentLength ? parseInt(contentLength, 10) : null,
        contentType: resp.headers.get("Content-Type") || "application/octet-stream",
        acceptRanges: true,
        contentRange: resp.headers.get("Content-Range") ?? null,
      };
    },

    /**
     * Upload a body to S3 via PutObject.
     * uri format: "s3://<sourceId>/<objectKey>"
     */
    async put(
      uri: string,
      body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
      contentType?: string,
    ): Promise<void> {
      const s3PrefixLen = "s3://".length;
      const slashIdx = uri.indexOf("/", s3PrefixLen);
      const key = slashIdx >= 0 ? uri.substring(slashIdx + 1) : "";

      const url = new URL(objectUrl(config, key));

      const { authorization, amzDate, contentSha256 } = await buildAuthorizationHeader({
        method: "PUT",
        url,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        service: "s3",
        payloadHash: "UNSIGNED-PAYLOAD",
      });

      const resp = await fetch(url.toString(), {
        method: "PUT",
        headers: {
          Authorization: authorization,
          "x-amz-date": amzDate,
          "x-amz-content-sha256": contentSha256,
          Host: url.host,
          "Content-Type": contentType || "application/octet-stream",
        },
        body: body as BodyInit,
      });

      if (!resp.ok) {
        throw new Error(`S3 PutObject ${resp.status}: ${await resp.text()}`);
      }
    },
  };
}
