import type { StorageAdapter, StreamResult } from "./index";
import { parseStorageUri, getSourceCredentials } from "./index";
import { md5 } from "../utils/md5";

export interface SubsonicAdapterOptions {
  // Anti-loop chain (DESIGN.md §3.2): IDs of every EdgeSonic hop so far.
  // Our own INSTANCE_ID is appended before forwarding upstream.
  instanceId?: string;
  incomingChain?: string[];
}

export function createSubsonicAdapter(db: D1Database, opts: SubsonicAdapterOptions = {}): StorageAdapter {
  return {
    async stream(uri: string, range?: string): Promise<StreamResult> {
      const { path } = parseStorageUri(uri);
      const creds = await getSourceCredentials(db, "subsonic");
      if (!creds) {
        return { body: null, statusCode: 401, contentLength: null, contentType: "text/plain", acceptRanges: false };
      }

      const salt = generateSalt(6);
      const token = md5(creds.password + salt);
      const chain = [...(opts.incomingChain ?? []), ...(opts.instanceId ? [opts.instanceId] : [])];
      const sep = path.includes("?") ? "&" : "?";
      let fullUrl = `${creds.baseUrl.replace(/\/$/, "")}/${path}${sep}u=${encodeURIComponent(creds.username)}&t=${token}&s=${salt}&v=1.16.1&c=EdgeSonic`;
      if (chain.length > 0) {
        fullUrl += `&esChain=${encodeURIComponent(chain.join(","))}`;
      }

      const headers: Record<string, string> = {};
      if (range) headers["Range"] = range;
      if (chain.length > 0) headers["X-EdgeSonic-Chain"] = chain.join(",");

      const resp = await fetch(fullUrl, { headers });
      return {
        body: resp.body,
        statusCode: resp.status,
        contentLength: parseInt(resp.headers.get("Content-Length") || "0", 10) || null,
        contentType: resp.headers.get("Content-Type") || "application/octet-stream",
        acceptRanges: resp.headers.get("Accept-Ranges") === "bytes",
      };
    },
  };
}

function generateSalt(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let salt = "";
  for (let i = 0; i < len; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}
