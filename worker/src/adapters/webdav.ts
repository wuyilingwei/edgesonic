import type { StorageAdapter, StreamResult } from "./index";
import { parseStorageUri, getSourceCredentials } from "./index";

// 068 — `env` is optional so legacy call sites still compile while we migrate
// them over. When provided, the password column may be a `v1:<base64url>` blob
// that's transparently decrypted via env.STORAGE_KEY. Without env (or with
// STORAGE_KEY unset) we fall back to the legacy plaintext path.
export function createWebDAVAdapter(
  db: D1Database,
  env?: { STORAGE_KEY?: string },
): StorageAdapter {
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
      const creds = await getSourceCredentials(db, "webdav", env);
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
      const creds = await getSourceCredentials(db, "webdav", env);
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
  };
}
