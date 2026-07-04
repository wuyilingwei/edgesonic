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

// 091 — R2 S3 presigned URL generator (SigV4, no external SDK).
//
// R2 is S3-compatible. To let the browser fetch R2 objects directly (bypassing
// the Worker sub-request bandwidth pool), we sign a short-lived URL using
// AWS Signature Version 4. The browser follows a 302 with no extra headers;
// the signature lives entirely in the query string.
//
// Reference: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
//
// Required env (Workers Secrets, NOT in wrangler.toml vars):
//   R2_ACCESS_KEY_ID     — S3 access key (R2 → Manage R2 API Tokens → Create)
//   R2_SECRET_ACCESS_KEY — S3 secret key
//   CF_ACCOUNT_ID        — Cloudflare account id (reused from 054 Cloudflare
//                           integration; pushed via Settings UI or
//                           `wrangler secret put CF_ACCOUNT_ID`)
//
// Region is hardcoded to "auto" — R2 ignores the region but SigV4 requires one.

const SERVICE = "s3";
const REGION = "auto";

// ---- Helpers ---------------------------------------------------------------

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    k as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
}

async function sha256Hex(msg: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return hex(buf);
}

function uriEncode(s: string, encodeSlash = true): string {
  let out = "";
  for (const ch of [...s]) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      ch === "-" || ch === "_" || ch === "." || ch === "~"
    ) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += "/";
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

// ---- Presign ---------------------------------------------------------------

export interface PresignOpts {
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  ttlSec?: number; // default 300 (5 min), max 604800 (7 days)
  rangeHeader?: string; // optional Range header to sign (e.g. "bytes=0-")
}

/**
 * Build a presigned R2 S3 GET URL with SigV4. The signature is in the query
 * string, so the browser can fetch it without any extra headers. If
 * `rangeHeader` is supplied, `range` is added to the signed headers list —
 * the browser will include the same Range header on the redirected request
 * only if it was the one initiating the fetch with Range (which it does for
 * media). We sign it so R2 won't reject the request as a tampered header.
 */
export async function presignR2Get(opts: PresignOpts): Promise<string> {
  const ttl = Math.min(Math.max(opts.ttlSec ?? 300, 1), 604800);
  // 093 — Use virtual-hosted style (https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key})
  // per R2 docs. Path style (https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key})
  // generates signatures whose host header doesn't match what R2 verifies → 403.
  const host = `${opts.bucket}.${opts.accountId}.r2.cloudflarestorage.com`;
  // S3 canonical URI is the path with `/` not double-encoded (encodeSlash=false
  // for canonical URI per S3 spec, since R2 keys use `/` as separator).
  const objectPath = `/${opts.key}`;
  const canonicalUri = uriEncode(objectPath, false);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const credential = `${opts.accessKeyId}/${credentialScope}`;

  // Query params (sorted by key for canonical form). We sign host only by
  // default; if a Range header is supplied we add `range` to SignedHeaders.
  const signedHeadersList = opts.rangeHeader ? ["host", "range"] : ["host"];
  const signedHeaders = signedHeadersList.join(";");

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  // Canonical query string: keys sorted, uri-encoded.
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k])}`)
    .join("&");

  // Canonical headers: lowercase, trimmed, sorted, each "name:value\n".
  const headerMap: Record<string, string> = { host };
  if (opts.rangeHeader) headerMap["range"] = opts.rangeHeader;
  const canonicalHeaders = signedHeadersList
    .map((h) => `${h}:${headerMap[h].trim()}\n`)
    .join("");

  // Hashed payload — for a GET without body, S3 allows "UNSIGNED-PAYLOAD".
  // For presigned URLs (no X-Amz-Content-Sha256 in query), use empty body hash.
  const payloadHash = await sha256Hex("");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Signing key chain: HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
  const kDate = await hmac(new TextEncoder().encode("AWS4" + opts.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const finalQuery: Record<string, string> = { ...queryParams, "X-Amz-Signature": signature };
  const queryString = Object.keys(finalQuery)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(finalQuery[k])}`)
    .join("&");

  return `https://${host}${canonicalUri}?${queryString}`;
}
