// 068 — AES-256-GCM password encryption for storage_sources rows.
//
// Threat model: D1 reads (CF dashboard, leaked backup, accidental SELECT) must
// not yield plaintext WebDAV / Subsonic credentials. Master key is injected
// via `wrangler secret put STORAGE_KEY` so it never enters the repo or D1.
//
// On-disk format:
//   "v1:" + base64url( nonce(12) || ciphertext || tag(16) )
//
// The `v1:` prefix lets `decryptPassword` distinguish encrypted blobs from
// legacy plaintext rows (decryptPassword returns those unchanged). That's the
// bridge that lets the adapter path keep working before migratePasswords runs.
//
// If env.STORAGE_KEY is unset/empty, callers fall back to the legacy plaintext
// column (see getDecryptedPassword in adapters/index.ts). We intentionally do
// NOT hard-fail when the secret is missing — that would break existing
// deployments mid-rollout. The trade-off is documented in worker/SECRETS.md.

const VERSION_PREFIX = "v1:";
const NONCE_BYTES = 12; // AES-GCM standard nonce
const TAG_BYTES = 16;   // 128-bit auth tag, appended by subtle.encrypt
const KEY_HEX_LENGTH = 64; // 32 bytes = 64 hex chars

/**
 * Decode a 64-char hex string into a 32-byte Uint8Array.
 * Throws on wrong length or non-hex characters so a misconfigured secret
 * fails loudly at the call site (admin sees "invalid STORAGE_KEY" rather
 * than a confusing decrypt error 5 minutes later).
 */
export function parseHexKey(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length !== KEY_HEX_LENGTH) {
    throw new Error(`STORAGE_KEY must be ${KEY_HEX_LENGTH} hex chars (32 bytes)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("STORAGE_KEY must be hex");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importAesKey(hexKey: string): Promise<CryptoKey> {
  const raw = parseHexKey(hexKey);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- base64url helpers (Workers `btoa` emits standard b64; swap chars) ---
function b64urlEncode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * AES-256-GCM encrypt with a fresh 12-byte nonce per call. Returns
 *   "v1:" + base64url(nonce || ciphertext || tag)
 * so the on-disk blob is self-contained (no separate nonce column).
 */
export async function encryptPassword(plaintext: string, key: string): Promise<string> {
  if (typeof plaintext !== "string") {
    throw new Error("encryptPassword: plaintext must be a string");
  }
  const cryptoKey = await importAesKey(key);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const pt = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    pt,
  );
  const ct = new Uint8Array(ctBuf);
  const blob = new Uint8Array(NONCE_BYTES + ct.length);
  blob.set(nonce, 0);
  blob.set(ct, NONCE_BYTES);
  return VERSION_PREFIX + b64urlEncode(blob);
}

/**
 * Decrypt a stored password.
 *   • `v1:...` prefix → AES-256-GCM decrypt.
 *   • No prefix       → treat as legacy plaintext, return unchanged (compat).
 *
 * Throws when the prefix says encrypted but the key is wrong, the blob is
 * malformed, or the tag fails. Callers in the adapter path should catch + log
 * and surface a 401 rather than crashing the request.
 */
export async function decryptPassword(stored: string, key: string): Promise<string> {
  if (typeof stored !== "string") return "";
  if (!stored.startsWith(VERSION_PREFIX)) return stored; // legacy plaintext

  const blobB64 = stored.substring(VERSION_PREFIX.length);
  if (!blobB64) throw new Error("decryptPassword: empty ciphertext");

  let blob: Uint8Array;
  try { blob = b64urlDecode(blobB64); }
  catch { throw new Error("decryptPassword: malformed base64"); }
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("decryptPassword: blob too short");
  }

  const nonce = blob.subarray(0, NONCE_BYTES);
  const body = blob.subarray(NONCE_BYTES); // ciphertext || tag
  const cryptoKey = await importAesKey(key);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      cryptoKey,
      body,
    );
  } catch {
    // Don't leak whether it was the tag or the key — same outward signal.
    throw new Error("decryptPassword: decrypt failed (key mismatch or corrupted)");
  }
  return new TextDecoder().decode(plainBuf);
}

/**
 * True iff the stored string is a `v1:` encrypted blob. UI uses this to
 * render the "encrypted" badge.
 */
export function isEncryptedPassword(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(VERSION_PREFIX);
}
