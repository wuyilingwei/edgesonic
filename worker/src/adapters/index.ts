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
