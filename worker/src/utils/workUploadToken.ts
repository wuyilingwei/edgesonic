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

// 053 — One-shot HMAC tokens for browser-pool transcode uploads.
//
// The browser-pool engine kicks off a transcode by writing a work_queue row
// and handing the browser a URL like:
//   /edgesonic/work/upload?id=<workQueueId>&token=<token>
// The token is a base64url-encoded
//   <expiresAtUnixSeconds>.<HMAC-SHA-256 of "id:expiresAt">
// so any tampering with id/exp invalidates the signature, and replay past the
// TTL is rejected outright. The upload endpoint additionally requires
// `work_queue.claimed_by === session.user.username` so even a leaked token
// can only be redeemed by the worker that actually claimed the row.
//
// HMAC secret derivation — see findings.md decision: we currently use
//   INSTANCE_ID + ':' + 'esp-upload-v1'
// because wrangler.toml does not expose a MASTER_KEY today. Task 054 will
// rotate this to a real wrangler secret; the API here is stable so callers
// don't need to change.

const STATIC_SALT = "esp-upload-v1";
const DEFAULT_TTL_SECONDS = 300;

// Derive the HMAC key from the instance identity. Returns a CryptoKey ready
// for sign / verify calls.
async function deriveKey(env: Env): Promise<CryptoKey> {
  const material = `${env.INSTANCE_ID}:${STATIC_SALT}`;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// base64url helpers — Workers `btoa` is available, but emits standard
// base64 (+ /). We swap the chars to make the token URL-safe.
function bytesToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Build the token. `nowSeconds` is overridable for tests.
export async function signUploadToken(
  env: Env,
  workQueueId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const exp = nowSeconds + Math.max(1, ttlSeconds);
  const key = await deriveKey(env);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${workQueueId}:${exp}`),
  );
  return `${exp}.${bytesToB64url(sig)}`;
}

// Verify a token. Returns ok=true when the signature matches the (id, exp)
// pair and exp is still in the future. ok=false carries a human-readable
// `reason` for logging — never leak it back to the worker as 4xx body, just
// use generic "invalid token" so we don't aid replay tuning.
export async function verifyUploadToken(
  env: Env,
  workQueueId: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing token" };
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed token" };
  const expStr = token.substring(0, dot);
  const sigStr = token.substring(dot + 1);
  if (!/^\d+$/.test(expStr)) return { ok: false, reason: "exp not int" };
  const exp = parseInt(expStr, 10);
  if (exp < nowSeconds) return { ok: false, reason: "expired" };

  let sigBytes: Uint8Array;
  try { sigBytes = b64urlToBytes(sigStr); }
  catch { return { ok: false, reason: "bad b64 sig" }; }

  const key = await deriveKey(env);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(`${workQueueId}:${exp}`),
  );
  return ok ? { ok: true } : { ok: false, reason: "sig mismatch" };
}
