import { Hono } from "hono";
import { permissionMiddleware } from "../auth";
import { md5 } from "../utils/md5";
import { parseTags } from "../utils/tags";
import { parseMultistatus, stripTrailingSlash, encodePath } from "./scan";

export const fileBrowseRoutes = new Hono();

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

function srcBaseUrl(src: SourceRow): string {
  const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
  return src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "");
}

// ============================================================================
// GET /rest/listFiles?source=r2|<sourceId>&path=<dir>
// Per-source file/folder browsing (web session only; JSON response)
// ============================================================================
fileBrowseRoutes.get("/rest/listFiles", permissionMiddleware("download"), async (c) => {
  const env = c.env as Env;
  const source = c.req.query("source") || "r2";
  const path = (c.req.query("path") || "").replace(/^\/+|\/+$/g, "");

  if (source === "r2") {
    const prefix = path ? `${path}/` : "";
    const listing = await env.MUSIC_BUCKET.list({ prefix, delimiter: "/" });
    return c.json({
      ok: true,
      source: "r2",
      path,
      dirs: listing.delimitedPrefixes.map((p) => ({
        name: p.substring(prefix.length).replace(/\/$/, ""),
      })),
      files: listing.objects.map((o) => ({
        name: o.key.substring(prefix.length),
        size: o.size,
        contentType: o.httpMetadata?.contentType || null,
        uri: `r2://${o.key}`,
      })),
    });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1"
  ).bind(source).first<SourceRow>();
  if (!src) return c.json({ ok: false, error: "Source not found" }, 404);

  const baseUrl = srcBaseUrl(src);
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const url = baseUrl + "/" + (path ? encodePath(path) + "/" : "");
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`,
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>`,
  });
  if (!resp.ok && resp.status !== 207) {
    return c.json({ ok: false, error: `PROPFIND failed: HTTP ${resp.status}` }, 502);
  }

  const entries = parseMultistatus(await resp.text(), basePath)
    .filter((e) => e.path !== path && e.path !== "");
  return c.json({
    ok: true,
    source: src.id,
    path,
    dirs: entries.filter((e) => e.isDir).map((e) => ({ name: e.path.split("/").pop() || e.path })),
    files: entries.filter((e) => !e.isDir).map((e) => ({
      name: e.path.split("/").pop() || e.path,
      size: e.size,
      contentType: e.contentType,
      uri: `webdav://${src.id}/${e.path}`,
    })),
  });
});

// ============================================================================
// GET /rest/scanTags?batch=N[&source=<id>]
// Read embedded tags for unscanned instances; rebuild artist/album linkage.
// Designed to be called in a loop from the web UI until remaining = 0.
// ============================================================================
fileBrowseRoutes.get("/rest/scanTags", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const batch = Math.min(parseInt(c.req.query("batch") || "16", 10) || 16, 16);
  const onlySource = c.req.query("source");

  const rows = (await db.prepare(
    `SELECT si.id, si.master_id, si.source_id, si.storage_uri, si.suffix
     FROM song_instances si WHERE si.tag_scanned = 0 ${onlySource ? "AND si.source_id = ?" : ""}
     LIMIT ?`
  ).bind(...(onlySource ? [onlySource, batch] : [batch]))
    .all<{ id: string; master_id: string; source_id: string; storage_uri: string; suffix: string }>()).results;

  const sources = new Map<string, SourceRow>();
  for (const s of (await db.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE enabled = 1"
  ).all<SourceRow>()).results) sources.set(s.id, s);

  const now = Math.floor(Date.now() / 1000);
  let processed = 0;
  let tagged = 0;
  const touchedAlbums = new Set<string>();

  for (const row of rows) {
    processed++;
    let scanned = 2; // default: no usable tags
    try {
      const slices = await fetchSlices(env, sources, row.storage_uri, row.suffix);
      if (slices) {
        const tags = parseTags(slices.head, slices.tail);
        if (tags && (tags.title || tags.artist || tags.album)) {
          const artistName = tags.albumArtist || tags.artist || "Unknown Artist";
          const albumName = tags.album || "Unknown Album";
          const artistId = "ar-" + md5(artistName).substring(0, 10);
          const albumId = "al-" + md5(artistName + " " + albumName).substring(0, 10);
          touchedAlbums.add(albumId);

          const stmts: D1PreparedStatement[] = [
            db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
              .bind(artistId, artistName, artistName.toLowerCase(), now, now),
            db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, tags.genre ?? null, now, now),
            db.prepare(
              `UPDATE song_masters SET
                 album_id = ?, artist_id = ?,
                 title = COALESCE(?, title), sort_title = COALESCE(?, sort_title),
                 track = COALESCE(?, track), genre = COALESCE(?, genre), updated_at = ?
               WHERE id = ?`
            ).bind(
              albumId, artistId,
              tags.title ?? null, tags.title ? tags.title.toLowerCase() : null,
              tags.track ?? null, tags.genre ?? null, now, row.master_id,
            ),
          ];
          await db.batch(stmts);
          scanned = 1;
          tagged++;
        }
      }
    } catch { /* leave scanned = 2 so we don't loop forever on broken files */ }
    await db.prepare("UPDATE song_instances SET tag_scanned = ? WHERE id = ?").bind(scanned, row.id).run();
  }

  // Refresh aggregates for albums that gained songs; drop emptied albums/artists
  for (const albumId of touchedAlbums) {
    await db.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
         size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                 JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
         updated_at = ?
       WHERE id = ?`
    ).bind(albumId, albumId, now, albumId).run();
  }
  if (touchedAlbums.size > 0) {
    await db.prepare("DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id)").run();
    await db.prepare(
      "DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id)"
    ).run();
  }

  const remaining = (await db.prepare(
    `SELECT COUNT(*) AS n FROM song_instances WHERE tag_scanned = 0 ${onlySource ? "AND source_id = ?" : ""}`
  ).bind(...(onlySource ? [onlySource] : [])).first<{ n: number }>())?.n ?? 0;

  return c.json({ ok: true, processed, tagged, remaining });
});

async function fetchSlices(
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
    // A server may ignore Range and answer 200 with the full file — never buffer it whole
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
