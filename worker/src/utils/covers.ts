import { locateEmbeddedPicture } from "./tags";
import { parseMultistatus, stripTrailingSlash, encodePath } from "../endpoints/storage/scan";

const IMAGE_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};
const PREFERRED_NAME = /cover|folder|front|albumart/i;
const HEAD_BYTES = 256 * 1024;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

/**
 * @deprecated 076 — no longer invoked from getCoverArt. The fallback path
 * incorrectly assigned shared parent-directory cover.jpg files to many
 * distinct albums (NAS root art polluting every child album). Kept here
 * pending a follow-up that scopes art lookup to the album's own directory
 * (vs. the file's parent). Until that lands, callers MUST treat missing
 * albums.cover_r2_key as "no cover available" — see media.ts:getCoverArt.
 *
 * On-demand album cover resolution:
 *   1. an image file (cover/folder/front/albumart, else the largest) in the
 *      directory of one of the album's WebDAV files
 *   2. embedded art (ID3v2 APIC / FLAC PICTURE) in one of the album's files
 * The result is cached in R2 (covers/<albumId>) and albums.cover_r2_key.
 */
export async function resolveAlbumCover(env: Env, albumId: string): Promise<string | null> {
  const db = env.DB;
  const inst = await db.prepare(
    `SELECT si.storage_uri FROM song_instances si
     JOIN song_masters sm ON sm.id = si.master_id
     WHERE sm.album_id = ? AND si.missing = 0
     ORDER BY CASE WHEN si.storage_uri LIKE 'webdav://%' THEN 0 ELSE 1 END
     LIMIT 1`
  ).bind(albumId).first<{ storage_uri: string }>();
  if (!inst) return null;

  let image: { body: ReadableStream<Uint8Array> | Uint8Array; contentType: string } | null = null;

  if (inst.storage_uri.startsWith("webdav://")) {
    const rest = inst.storage_uri.substring(9);
    const slash = rest.indexOf("/");
    const sourceId = rest.substring(0, slash);
    const filePath = rest.substring(slash + 1);
    const src = await db.prepare(
      "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1"
    ).bind(sourceId).first<SourceRow>();
    if (!src) return null;

    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const baseUrl = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;
    const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";

    image = await findDirectoryImage(baseUrl, auth, dir)
      || await extractEmbedded((range) => fetchWebdavRange(baseUrl, auth, filePath, range));
  } else if (inst.storage_uri.startsWith("r2://")) {
    const key = inst.storage_uri.substring(5);
    image = await extractEmbedded(async (range) => {
      const obj = await env.MUSIC_BUCKET.get(key, { range });
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    });
  }

  if (!image) return null;
  const coverKey = `covers/${albumId}`;
  await env.MUSIC_BUCKET.put(coverKey, image.body, { httpMetadata: { contentType: image.contentType } });
  await db.prepare("UPDATE albums SET cover_r2_key = ?, updated_at = ? WHERE id = ?")
    .bind(coverKey, Math.floor(Date.now() / 1000), albumId).run();
  return coverKey;
}

async function findDirectoryImage(
  baseUrl: string,
  auth: string,
  dir: string,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const url = baseUrl + "/" + (dir ? encodePath(dir) + "/" : "");
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: auth, Depth: "1", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>`,
  });
  if (!resp.ok && resp.status !== 207) return null;

  const images = parseMultistatus(await resp.text(), basePath)
    .filter((e) => !e.isDir && IMAGE_EXT[extOf(e.path)] !== undefined && e.size <= MAX_PICTURE_BYTES);
  if (images.length === 0) return null;

  images.sort((a, b) => {
    const ap = PREFERRED_NAME.test(a.path) ? 0 : 1;
    const bp = PREFERRED_NAME.test(b.path) ? 0 : 1;
    return ap !== bp ? ap - bp : b.size - a.size;
  });
  const pick = images[0];
  const getResp = await fetch(baseUrl + "/" + encodePath(pick.path), { headers: { Authorization: auth } });
  if (!getResp.ok || !getResp.body) return null;
  return { body: getResp.body, contentType: IMAGE_EXT[extOf(pick.path)] };
}

async function extractEmbedded(
  fetchRange: (range: { offset: number; length: number }) => Promise<Uint8Array | null>,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const head = await fetchRange({ offset: 0, length: HEAD_BYTES });
  if (!head || head.length === 0) return null;
  const pic = locateEmbeddedPicture(head);
  if (!pic || pic.length > MAX_PICTURE_BYTES) return null;

  // Fully contained in the head slice — no extra request needed
  if (pic.offset + pic.length <= head.length) {
    return { body: head.subarray(pic.offset, pic.offset + pic.length), contentType: pic.mime };
  }
  const data = await fetchRange({ offset: pic.offset, length: pic.length });
  if (!data || data.length < pic.length) return null;
  return { body: data, contentType: pic.mime };
}

async function fetchWebdavRange(
  baseUrl: string,
  auth: string,
  filePath: string,
  range: { offset: number; length: number },
): Promise<Uint8Array | null> {
  const resp = await fetch(baseUrl + "/" + encodePath(filePath), {
    headers: { Authorization: auth, Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
  });
  if (!resp.ok && resp.status !== 206) return null;
  if (!resp.body) return null;
  // Guard against servers that ignore Range and send the whole file
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < range.length) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, range.length));
  let off = 0;
  for (const ch of chunks) {
    const n = Math.min(ch.length, out.length - off);
    out.set(ch.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.substring(i + 1).toLowerCase() : "";
}
