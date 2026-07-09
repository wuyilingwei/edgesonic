// and the s3.ts adapter (Authorization header signing).
//
// Both modes use the same canonical-request / string-to-sign format;
// they differ only in how the signature is delivered:
//   • Presign: signature in query string (X-Amz-Signature=…)
//   • Auth header: signature in Authorization: AWS4-HMAC-SHA256 header

// ---------------------------------------------------------------------------
// Low-level crypto helpers
// ---------------------------------------------------------------------------

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
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

export async function sha256Hex(msg: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return hex(buf);
}

/**
 * SigV4 URI-encoding: percent-encode everything except unreserved chars.
 * When encodeSlash=false, forward slashes are kept (used for canonical URI
 * and multi-segment path components).
 */
export function uriEncode(s: string, encodeSlash = true): string {
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

// ---------------------------------------------------------------------------
// Signing key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the SigV4 signing key for (secret, date, region, service).
 * HMAC chain: "AWS4" + secret → dateStamp → region → service → "aws4_request"
 */
export async function deriveSigV4Key(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode("AWS4" + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// ---------------------------------------------------------------------------
// Authorization header builder (non-presigned, in-flight requests)
// ---------------------------------------------------------------------------

export interface AuthHeaderResult {
  authorization: string;
  amzDate: string;
  contentSha256: string;
}

/**
 * Build a SigV4 Authorization header for an outbound request.
 *
 * Returns the three headers callers must include:
 *   Authorization: AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…
 *   x-amz-date: <ISO 8601 compact>
 *   x-amz-content-sha256: UNSIGNED-PAYLOAD (or real hash)
 *
 * extraHeaders — additional request headers to include in the signature
 * (their values must be present on the actual request). The headers
 * host, x-amz-date, and x-amz-content-sha256 are always signed.
 */
export async function buildAuthorizationHeader(opts: {
  method: string;
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  payloadHash: string; // "UNSIGNED-PAYLOAD" or actual sha256 hex
  extraHeaders?: Record<string, string>;
}): Promise<AuthHeaderResult> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const host = opts.url.host; // includes port if non-default

  // Build the header map to sign: host + x-amz-date + x-amz-content-sha256
  // + any caller-supplied extras. Keys lowercased, values trimmed.
  const toSign: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": opts.payloadHash,
  };
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      toSign[k.toLowerCase()] = v.trim();
    }
  }

  // Sorted header names for SignedHeaders list
  const sortedKeys = Object.keys(toSign).sort();
  const signedHeaders = sortedKeys.join(";");

  // Canonical headers: "name:value\n" for each
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${toSign[k]}\n`).join("");

  // Canonical URI: path, slash-preserving, double-slash collapsed
  const canonicalUri = uriEncode(opts.url.pathname || "/", false);

  // Canonical query string: sort by param name, uri-encode each
  const params: Array<[string, string]> = [];
  opts.url.searchParams.forEach((v, k) => params.push([k, v]));
  params.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const canonicalQuery = params
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigV4Key(opts.secretAccessKey, dateStamp, opts.region, opts.service);
  const signature = hex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate, contentSha256: opts.payloadHash };
}
