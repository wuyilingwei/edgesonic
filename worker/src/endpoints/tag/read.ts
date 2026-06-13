// 055 — Tag scanner (formerly /rest/scanTags). Reads embedded tags for
// unscanned song_instances and rebuilds artist/album linkage. Designed to be
// driven in a loop from the web UI until remaining = 0.
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { md5 } from "../../utils/md5";
import { parseTags } from "../../utils/tags";
import { fetchSlices, type SourceRow } from "../../utils/slices";

export const tagReadRoutes = new Hono();

// GET /tag/read?batch=N[&source=<id>]
tagReadRoutes.get("/read", permissionMiddleware("manage_sources"), async (c) => {
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
