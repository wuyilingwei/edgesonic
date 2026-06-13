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

// 055 — Shared between storage/browse.ts (listFiles) and tag/read.ts (scanTags).
// Both endpoints need to fetch head/tail bytes from R2 or WebDAV sources so they
// can parse embedded tags without buffering whole files.
import { encodePath } from "../endpoints/storage/scan";

export interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 128 * 1024;

export function srcBaseUrl(src: SourceRow): string {
  const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
  return src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
}

export async function fetchSlices(
  env: Env,
  sources: Map<string, SourceRow>,
  storageUri: string,
  suffix: string,
): Promise<{ head: Uint8Array; tail?: Uint8Array } | null> {
  const needTail = suffix === "wav" || suffix === "aiff";

  if (storageUri.startsWith("r2://")) {
    const key = storageUri.substring(5);
    const headObj = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: HEAD_BYTES } });
    if (!headObj) return null;
    const head = new Uint8Array(await headObj.arrayBuffer());
    let tail: Uint8Array | undefined;
    if (needTail) {
      const tailObj = await env.MUSIC_BUCKET.get(key, { range: { suffix: TAIL_BYTES } });
      if (tailObj) tail = new Uint8Array(await tailObj.arrayBuffer());
    }
    return { head, tail };
  }

  if (storageUri.startsWith("webdav://")) {
    const rest = storageUri.substring(9);
    const slash = rest.indexOf("/");
    const sourceId = rest.substring(0, slash);
    const path = rest.substring(slash + 1);
    const src = sources.get(sourceId);
    if (!src) return null;
    const url = srcBaseUrl(src) + "/" + encodePath(path);
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;

    const headResp = await fetch(url, { headers: { Authorization: auth, Range: `bytes=0-${HEAD_BYTES - 1}` } });
    if (!headResp.ok && headResp.status !== 206) return null;
    const head = await readLimited(headResp, HEAD_BYTES);
    let tail: Uint8Array | undefined;
    if (needTail) {
      const tailResp = await fetch(url, { headers: { Authorization: auth, Range: `bytes=-${TAIL_BYTES}` } });
      if (tailResp.status === 206) tail = await readLimited(tailResp, TAIL_BYTES);
      else if (tailResp.body) await tailResp.body.cancel();
    }
    return { head, tail };
  }

  return null;
}

async function readLimited(resp: Response, limit: number): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const ch of chunks) {
    const n = Math.min(ch.length, out.length - off);
    out.set(ch.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}
