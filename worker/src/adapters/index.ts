export interface StorageAdapter {
  stream(uri: string, range?: string): Promise<StreamResult>;
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

export async function getSourceCredentials(
  db: D1Database,
  scheme: "webdav" | "subsonic"
): Promise<{ username: string; password: string; baseUrl: string } | null> {
  const source = await db
    .prepare("SELECT * FROM storage_sources WHERE type = ? AND enabled = 1 LIMIT 1")
    .bind(scheme)
    .first<{ base_url: string; username: string | null; password: string | null; root_path: string | null }>();

  if (!source) return null;
  const root = (source.root_path || "").replace(/^\/+|\/+$/g, "");
  return {
    username: source.username || "",
    password: source.password || "",
    baseUrl: source.base_url.replace(/\/+$/, "") + (root ? `/${root}` : ""),
  };
}
