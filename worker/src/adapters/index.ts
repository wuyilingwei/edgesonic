import { decryptPassword, isEncryptedPassword } from "../utils/sourceCrypto";

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
  scheme: "r2" | "url" | "webdav" | "subsonic";
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

// 068 — Row shape used by getSourceCredentials / migratePasswords. Keep
// `password` for legacy plaintext rows and `password_encrypted` for v1 blobs
// (`v1:<base64url>`). adapter path reads whichever is set.
interface SourceRow {
  base_url: string;
  username: string | null;
  password: string | null;
  password_encrypted: string | null;
  root_path: string | null;
}

/**
 * 068 — Pull the plaintext password from a `storage_sources` row.
 *
 *   • `password_encrypted` present AND env.STORAGE_KEY configured → decrypt.
 *   • Otherwise → fall back to the legacy `password` column (empty-string-safe).
 *
 * Never throws on a missing STORAGE_KEY — that path is the rollout window
 * before the operator pushes the secret. A failed decrypt (key mismatch /
 * corruption) DOES throw; the caller surfaces it as a 401 / 500.
 */
export async function getDecryptedPassword(
  row: { password: string | null; password_encrypted: string | null },
  env?: { STORAGE_KEY?: string },
): Promise<string> {
  const enc = row.password_encrypted;
  const key = env?.STORAGE_KEY;
  if (enc && isEncryptedPassword(enc) && key && key.length > 0) {
    return decryptPassword(enc, key);
  }
  // password_encrypted set but STORAGE_KEY missing → fall through to legacy
  // plaintext (if any). The migrate endpoint is the right place to detect
  // this misconfiguration, not the hot path.
  return row.password || "";
}

export async function getSourceCredentials(
  db: D1Database,
  scheme: "webdav" | "subsonic",
  env?: { STORAGE_KEY?: string },
): Promise<{ username: string; password: string; baseUrl: string } | null> {
  const source = await db
    .prepare(
      "SELECT base_url, username, password, password_encrypted, root_path FROM storage_sources WHERE type = ? AND enabled = 1 LIMIT 1",
    )
    .bind(scheme)
    .first<SourceRow>();

  if (!source) return null;
  const root = (source.root_path || "").replace(/^\/+|\/+$/g, "");
  const password = await getDecryptedPassword(source, env);
  return {
    username: source.username || "",
    password,
    baseUrl: source.base_url.replace(/\/+$/, "") + (root ? `/${root}` : ""),
  };
}
