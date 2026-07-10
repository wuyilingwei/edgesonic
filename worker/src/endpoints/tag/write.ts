import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { md5 } from "../../utils/md5";
import { createQueries } from "../../db/queries";

type Queries = ReturnType<typeof createQueries>;
import { requiredPrefixLen, rebuildTagPrefix } from "../../utils/tagwrite";
import type { TagWriteCover } from "../../utils/tagwrite";
import { encodePath } from "../storage/scan";
import type { SongTags } from "../../utils/tags";
import { dispatchWorkBatch } from "../edgesonic/work";

export const tagEditRoutes = new Hono();

// strings verbatim; the worker interprets them. They are matched exactly
// (case-sensitive, no surrounding whitespace) so real tag values that happen
// to contain these tokens are unaffected.
const KW_NULL = "{null}";
const KW_WRITE = "{write}";
const KW_EXPORT = "{export}";
const KEYWORDS = new Set([KW_NULL, KW_WRITE, KW_EXPORT]);
function isKeyword(v: unknown): boolean {
  return typeof v === "string" && KEYWORDS.has(v);
}
// Fields that support keyword semantics. lyrics + a dedicated cover keyword
// channel (coverData carries the literal — see parseCoverKeyword below).
function isLyricsKeyword(v: unknown): boolean {
  return isKeyword(v) && (v === KW_NULL || v === KW_WRITE || v === KW_EXPORT);
}

const HEAD_FETCH = 512 * 1024;
const MAX_REWRITE_BYTES = 80 * 1024 * 1024; // whole file is buffered for the rewrite
const MAX_COVER_BYTES = 500 * 1024;
const BATCH_MAX = 50; // Workers single-request CPU budget bounds batch fan-out (see findings.md)

interface SourceRow {
  id: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

interface FileResult {
  instanceId: string;
  uri: string;
  written: boolean;
  reason?: string;
}

interface ApplyResult {
  ok: boolean;
  masterId?: string;
  albumId?: string;
  artistId?: string;
  files?: FileResult[];
  error?: string;
}

// ============================================================================
// POST /rest/writeTags  body: { id: <masterId|instanceId>, tags: SongTags }
// Single-song edit. The batch endpoint reuses applyTagsToSong below.
// ============================================================================
tagEditRoutes.post("/write", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{ id?: string; tags?: SongTags; coverData?: string; coverMime?: string }>().catch(() => null);
  if (!body?.id || !body.tags) return c.json({ ok: false, error: "Missing id or tags" }, 400);

  const tags = cleanInput(body.tags);
  // `coverData` instead of base64 image bytes. Detected here so parseCover never
  // sees it (it would fail base64 decoding and 400 the request).
  const coverKeyword = (body.coverData === KW_WRITE || body.coverData === KW_EXPORT) ? body.coverData : undefined;
  const parsed = coverKeyword ? null : parseCover(body.coverData, body.coverMime);
  if (parsed && "error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
  const cover = parsed ?? undefined;
  // tag fields are optional when a cover is provided — cover-only edits still legitimately update the file
  if (!Object.keys(tags).length && !cover && !coverKeyword) return c.json({ ok: false, error: "No tag fields provided" }, 400);

  const sources = await loadSources(db);
  const res = await applyTagsToSong(env, db, queries, sources, body.id, tags, cover, coverKeyword);
  if (!res.ok) {
    const status = res.error === "Song not found" ? 404 : 500;
    return c.json({ ok: false, error: res.error || "Write failed" }, status);
  }
  return c.json({
    ok: true,
    masterId: res.masterId,
    albumId: res.albumId,
    artistId: res.artistId,
    files: res.files,
  });
});

// ============================================================================
// POST /rest/batchWriteTags  body: { ids: string[], patch: Partial<SongTags> }
// Applies the same tag patch to up to BATCH_MAX songs; per-song results.
// ============================================================================
tagEditRoutes.post("/batchWrite", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{ ids?: string[]; patch?: SongTags; coverData?: string; coverMime?: string }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || !body.patch) {
    return c.json({ ok: false, error: "Missing ids or patch" }, 400);
  }
  if (body.ids.length === 0) return c.json({ ok: false, error: "Empty ids" }, 400);
  if (body.ids.length > BATCH_MAX) {
    return c.json({ ok: false, error: `Batch size exceeds limit (${BATCH_MAX})` }, 400);
  }

  const patch = cleanInput(body.patch);
  const coverKeyword = (body.coverData === KW_WRITE || body.coverData === KW_EXPORT) ? body.coverData : undefined;
  const parsed = coverKeyword ? null : parseCover(body.coverData, body.coverMime);
  if (parsed && "error" in parsed) return c.json({ ok: false, error: parsed.error }, 400);
  const cover = parsed ?? undefined;
  if (!Object.keys(patch).length && !cover && !coverKeyword) {
    return c.json({ ok: false, error: "Patch contains no recognised fields" }, 400);
  }

  const sources = await loadSources(db);
  const results: Array<{
    id: string;
    ok: boolean;
    masterId?: string;
    error?: string;
    files?: FileResult[];
  }> = [];
  let succeeded = 0;
  let failed = 0;

  // Sequential: keeps D1 contention low and stays within the Workers CPU budget
  // for a 50-item burst. Each entry is independent — one bad id never poisons
  // the others; per-row error string lands on the failed result.
  for (const id of body.ids) {
    try {
      const res = await applyTagsToSong(env, db, queries, sources, id, patch, cover, coverKeyword);
      if (res.ok) {
        succeeded++;
        results.push({ id, ok: true, masterId: res.masterId, files: res.files });
      } else {
        failed++;
        results.push({ id, ok: false, error: res.error || "Write failed" });
      }
    } catch (e) {
      failed++;
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({ ok: true, results, succeeded, failed });
});

// ============================================================================
// POST /tag/rescan  body: { ids: string[] }
// Library.vue batch toolbar "重新扫描" action. For each master id,
// resets tag_scanned=0 on its 'original' instances (transcoded/cached
// derivatives are skipped — re-reading a transcode output's tags is
// meaningless, we want the true source file re-parsed) and force-redispatches
// a metadata work_queue task with upsert:true so an instance whose task_queue
// row already reached a terminal state actually comes back to 'queued'
// instead of the INSERT OR IGNORE dedupKey no-op (see work.ts DispatchInput).
// ============================================================================
tagEditRoutes.post("/rescan", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{ ids?: string[] }>().catch(() => null);
  if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ ok: false, error: "Missing ids" }, 400);
  }
  if (body.ids.length > BATCH_MAX) {
    return c.json({ ok: false, error: `Batch size exceeds limit (${BATCH_MAX})` }, 400);
  }

  const targets: Array<{ instanceId: string; uri: string; suffix: string; size: number }> = [];
  let skipped = 0;
  for (const masterId of body.ids) {
    const instances = await queries.getSongInstances(masterId);
    const originals = instances.filter((i) => i.source_type === "original");
    if (originals.length === 0) { skipped++; continue; }
    for (const inst of originals) {
      targets.push({ instanceId: inst.id, uri: inst.storage_uri, suffix: inst.suffix, size: inst.size ?? 0 });
    }
  }
  if (targets.length === 0) {
    return c.json({ ok: false, error: "No eligible (original) instances found for the given ids" }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const resetStmts = targets.map((t) =>
    db.prepare("UPDATE song_instances SET tag_scanned = 0, updated_at = ? WHERE id = ?").bind(now, t.instanceId));
  for (let i = 0; i < resetStmts.length; i += 80) {
    await db.batch(resetStmts.slice(i, i + 80));
  }

  const dispatchedIds = await dispatchWorkBatch(db, targets.map((t) => ({
    taskType: "metadata",
    payload: { instanceId: t.instanceId, sourceUri: t.uri, suffix: t.suffix, size: t.size },
    requiredCaps: ["music-metadata"],
    priority: 3, // ahead of routine scan dispatch (priority 5) — user explicitly asked for this
    dedupKey: t.instanceId,
    upsert: true,
  })));

  return c.json({ ok: true, dispatched: dispatchedIds.length, skipped });
});

// ============================================================================
// Core: apply a tag patch to a single song (D1 relink + per-instance file write).
// Used by both writeTags (single) and batchWriteTags (loop).
//
// the cover field; `tags.lyrics` may carry the same keywords for the lyrics
// field. The keyword detection happens here (worker-side), the frontend just
// forwards whatever string the user typed.
// ============================================================================
async function applyTagsToSong(
  env: Env,
  db: D1Database,
  queries: Queries,
  sources: Map<string, SourceRow>,
  idOrInstanceId: string,
  tags: SongTags,
  cover?: TagWriteCover,
  coverKeyword?: string,
): Promise<ApplyResult> {
  let master = await queries.getSongMaster(idOrInstanceId);
  if (!master) {
    const inst = await queries.getSongInstance(idOrInstanceId);
    if (inst) master = await queries.getSongMaster(inst.master_id);
  }
  if (!master) return { ok: false, error: "Song not found" };

  // tags.lyrics; we pull it out here so the downstream D1 UPDATE / file write
  // branches can distinguish "write the D1 value back into the file" from a
  // normal lyric string edit.
  const lyricsKeyword = isLyricsKeyword(tags.lyrics) ? tags.lyrics : undefined;
  if (lyricsKeyword) delete tags.lyrics;

  // lyrics string so buildUSLTFrame / buildVorbisComment emit it. We re-inject
  // it into `tags.lyrics` (a real string, not a keyword) right before the
  // rewriteInstance loop. The D1 row is already current (no UPDATE needed for
  // a `{write}` since the value is unchanged), so we skip the COALESCE path
  // for lyrics by leaving tags.lyrics set only when the keyword is `{write}`.
  if (lyricsKeyword === KW_WRITE && master.lyrics) {
    tags.lyrics = master.lyrics;
  }

  // same directory as each instance. These are best-effort; read-only sources
  // (url://, subsonic://) are silently skipped. D1 is untouched by export.
  if (lyricsKeyword === KW_EXPORT || coverKeyword === KW_EXPORT) {
    const instances = await queries.getSongInstances(master.id);
    for (const inst of instances) {
      if (lyricsKeyword === KW_EXPORT && master.lyrics) {
        await exportLrcSidecar(env, sources, inst.storage_uri, master.lyrics).catch(() => {});
      }
      if (coverKeyword === KW_EXPORT) {
        const album = await db.prepare("SELECT cover_r2_key FROM albums WHERE id = ?")
          .bind(master.album_id).first<{ cover_r2_key: string | null }>();
        if (album?.cover_r2_key) {
          const obj = await env.MUSIC_BUCKET.get(album.cover_r2_key);
          if (obj) {
            const bytes = new Uint8Array(await obj.arrayBuffer());
            await exportCoverSidecar(env, sources, inst.storage_uri, bytes).catch(() => {});
          }
        }
      }
    }
    // export is a pure sidecar op — no D1 mutation, no embedded rewrite.
    // If only export was requested (no other tag fields, no embedded cover
    // write), return now; otherwise fall through to handle the rest.
    const onlyExport = !Object.keys(tags).length && !cover &&
      (!coverKeyword || coverKeyword === KW_EXPORT) &&
      (!lyricsKeyword || lyricsKeyword === KW_EXPORT);
    if (onlyExport) {
      return { ok: true, masterId: master.id, albumId: master.album_id, artistId: master.artist_id, files: [] };
    }
  }

  // rewriteInstance as a TagWriteCover so buildAPICFrame / buildFLACPictureBlock
  // embed them into each instance.
  if (coverKeyword === KW_WRITE && !cover) {
    const album = await db.prepare("SELECT cover_r2_key FROM albums WHERE id = ?")
      .bind(master.album_id).first<{ cover_r2_key: string | null }>();
    if (album?.cover_r2_key) {
      const obj = await env.MUSIC_BUCKET.get(album.cover_r2_key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= MAX_COVER_BYTES) {
          const mime = (obj.httpMetadata?.contentType || "image/jpeg").toLowerCase();
          const normalized = (mime === "image/png") ? "image/png" : "image/jpeg";
          cover = { mime: normalized, data: bytes };
        }
      }
    }
    // If the album has no cover or R2 fetch failed, fall through with no cover
    // — the tag patch (if any) still applies.
  }

  // --- D1 relink (same id derivation as scanTags so edits and scans converge) ---
  // Cover-only edits skip D1 mutation entirely — there is no field to relink.
  if (!Object.keys(tags).length && cover) {
    const instances = await queries.getSongInstances(master.id);
    const files: FileResult[] = [];
    for (const inst of instances) {
      const res = await rewriteInstance(env, sources, inst.storage_uri, (inst.suffix || "").toLowerCase(), inst.content_type, tags, cover)
        .catch((e): { written: boolean; reason?: string; newSize?: number } =>
          ({ written: false, reason: e instanceof Error ? e.message : String(e) }));
      if (res.written && typeof res.newSize === "number") {
        await db.prepare("UPDATE song_instances SET size = ?, updated_at = ? WHERE id = ?")
          .bind(res.newSize, Math.floor(Date.now() / 1000), inst.id).run();
      }
      files.push({ instanceId: inst.id, uri: inst.storage_uri, written: res.written, reason: res.reason });
    }
    return { ok: true, masterId: master.id, albumId: master.album_id, artistId: master.artist_id, files };
  }

  const curArtist = await db.prepare("SELECT name FROM artists WHERE id = ?")
    .bind(master.artist_id).first<{ name: string }>();
  const curAlbum = await db.prepare("SELECT name FROM albums WHERE id = ?")
    .bind(master.album_id).first<{ name: string }>();

  // album/albumArtist/genre) the keyword has already been preserved by
  // cleanInput as the literal token; we translate it to an empty string here
  // so the relink + UPDATE path writes '' into D1. For lyrics, `{null}` means
  // UPDATE lyrics = NULL (handled below via a dedicated branch). For numeric
  // fields (year/track) we don't accept `{null}` — cleanInput never passes
  // them through as keywords (only lyrics is keyword-enabled in cleanInput).
  const title = tags.title === KW_NULL ? "" : (tags.title || master.title);
  const artistName = tags.artist === KW_NULL ? "Unknown Artist" : (tags.artist || curArtist?.name || "Unknown Artist");
  const linkArtistName = tags.albumArtist === KW_NULL ? artistName : (tags.albumArtist || artistName);
  const albumName = tags.album === KW_NULL ? "Unknown Album" : (tags.album || curAlbum?.name || "Unknown Album");
  const genreValue = tags.genre === KW_NULL ? "" : tags.genre;
  const artistId = "ar-" + md5(linkArtistName).substring(0, 10);
  const albumId = "al-" + md5(linkArtistName + " " + albumName).substring(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const oldAlbumId = master.album_id;

  //   `{null}` → explicit UPDATE lyrics = NULL (separate stmt below)
  //   `{write}` → D1 unchanged; tags.lyrics now holds master.lyrics so the
  //               COALESCE path writes the same value back (no-op effectively)
  //   `{export}` → D1 unchanged (handled above, sidecar only)
  //   normal string → COALESCE path (existing behaviour)
  const lyricsNull = lyricsKeyword === KW_NULL;

  await db.batch([
    db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(artistId, linkArtistName, linkArtistName.toLowerCase(), now, now),
    db.prepare("INSERT OR IGNORE INTO albums (id, name, sort_name, year, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(albumId, albumName, albumName.toLowerCase(), tags.year ?? null, genreValue ?? null, now, now),
    db.prepare(
      `UPDATE song_masters SET
         album_id = ?, artist_id = ?, title = ?, sort_title = ?,
         track = COALESCE(?, track), genre = COALESCE(?, genre),
         lyrics = COALESCE(?, lyrics), updated_at = ?
       WHERE id = ?`
    ).bind(albumId, artistId, title, title.toLowerCase(), tags.track ?? null, genreValue ?? null, tags.lyrics ?? null, now, master.id),
    // manual edits win over future scans
    db.prepare("UPDATE song_instances SET tag_scanned = 1 WHERE master_id = ?").bind(master.id),
  ]);
  if (lyricsNull) {
    // explicit UPDATE. This is the only field whose "clear" semantics map
    // to SQL NULL (string fields use '' via the relink path above).
    await db.prepare("UPDATE song_masters SET lyrics = NULL, updated_at = ? WHERE id = ?")
      .bind(now, master.id).run();
  }
  if (tags.year || genreValue) {
    await db.prepare("UPDATE albums SET year = COALESCE(?, year), genre = ?, updated_at = ? WHERE id = ?")
      .bind(tags.year ?? null, genreValue ?? null, now, albumId).run();
  }

  // refresh aggregates for both the new and the vacated album, then sweep empties
  for (const aid of new Set([albumId, oldAlbumId])) {
    await db.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM song_masters WHERE album_id = ?),
         size = (SELECT COALESCE(SUM(si.size), 0) FROM song_instances si
                 JOIN song_masters sm ON sm.id = si.master_id WHERE sm.album_id = ?),
         updated_at = ?
       WHERE id = ?`
    ).bind(aid, aid, now, aid).run();
  }
  await db.prepare("DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id = albums.id)").run();
  await db.prepare(
    "DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id)"
  ).run();

  // --- file write-back per instance ---
  const instances = await queries.getSongInstances(master.id);
  const files: FileResult[] = [];
  for (const inst of instances) {
    const res = await rewriteInstance(env, sources, inst.storage_uri, (inst.suffix || "").toLowerCase(), inst.content_type, tags, cover)
      .catch((e): { written: boolean; reason?: string; newSize?: number } =>
        ({ written: false, reason: e instanceof Error ? e.message : String(e) }));
    if (res.written && typeof res.newSize === "number") {
      await db.prepare("UPDATE song_instances SET size = ?, updated_at = ? WHERE id = ?")
        .bind(res.newSize, now, inst.id).run();
    }
    files.push({ instanceId: inst.id, uri: inst.storage_uri, written: res.written, reason: res.reason });
  }

  return { ok: true, masterId: master.id, albumId, artistId, files };
}

async function loadSources(db: D1Database): Promise<Map<string, SourceRow>> {
  const sources = new Map<string, SourceRow>();
  const rows = await db.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE enabled = 1"
  ).all<SourceRow>();
  for (const s of rows.results) sources.set(s.id, s);
  return sources;
}

// Validate + decode `coverData` (base64) and `coverMime` from the request body.
// Returns null when no cover was supplied, a TagWriteCover on success, or an
// { error } envelope so the caller can pass it through to a 400 response.
function parseCover(coverData?: string, coverMime?: string): TagWriteCover | { error: string } | null {
  if (!coverData) return null;
  const mime = (coverMime || "image/jpeg").toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png") {
    return { error: `Unsupported cover mime: ${mime}` };
  }
  const data = decodeBase64(coverData);
  if (!data) return { error: "Invalid base64 coverData" };
  if (data.length > MAX_COVER_BYTES) {
    return { error: `Cover exceeds ${MAX_COVER_BYTES} bytes (${data.length})` };
  }
  if (data.length === 0) return { error: "Empty cover data" };
  return { mime, data };
}

function decodeBase64(s: string): Uint8Array | null {
  try {
    // strip whitespace + optional data URL prefix the UI may forward
    const clean = s.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// of headroom for plain-text translations / annotations while keeping a single
// row well under D1's per-row limit.
const MAX_LYRICS_BYTES = 50 * 1024;

function cleanInput(t: SongTags): SongTags {
  const out: SongTags = {};
  // can detect them. Only lyrics supports `{write}` / `{export}`; other fields
  // accept just `{null}` (clear). Normal non-keyword values go through the
  // existing trim-non-empty path.
  if (t.title === KW_NULL) out.title = KW_NULL;
  else if (t.title?.trim()) out.title = t.title.trim();
  if (t.artist === KW_NULL) out.artist = KW_NULL;
  else if (t.artist?.trim()) out.artist = t.artist.trim();
  if (t.album === KW_NULL) out.album = KW_NULL;
  else if (t.album?.trim()) out.album = t.album.trim();
  if (t.albumArtist === KW_NULL) out.albumArtist = KW_NULL;
  else if (t.albumArtist?.trim()) out.albumArtist = t.albumArtist.trim();
  if (t.genre === KW_NULL) out.genre = KW_NULL;
  else if (t.genre?.trim()) out.genre = t.genre.trim();
  const track = Number(t.track), year = Number(t.year);
  if (Number.isInteger(track) && track > 0) out.track = track;
  if (Number.isInteger(year) && year > 0) out.year = year;
  // (USLT / VORBIS LYRICS) is handled via rewriteInstance when the instance is
  // mp3/flac and the source is writable (r2/webdav). D1 sync is always kept.
  if (typeof t.lyrics === "string") {
    if (isLyricsKeyword(t.lyrics)) {
      out.lyrics = t.lyrics;
    } else {
      const trimmed = t.lyrics.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_LYRICS_BYTES) {
        out.lyrics = trimmed;
      }
    }
  }
  return out;
}

async function rewriteInstance(
  env: Env,
  sources: Map<string, SourceRow>,
  uri: string,
  suffix: string,
  contentType: string | null,
  tags: SongTags,
  cover?: TagWriteCover,
): Promise<{ written: boolean; reason?: string; newSize?: number }> {
  if (suffix !== "mp3" && suffix !== "flac") return { written: false, reason: `format .${suffix} not rewritable` };

  if (uri.startsWith("r2://")) {
    const key = uri.substring(5);
    const headObj = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: HEAD_FETCH } });
    if (!headObj) return { written: false, reason: "object not found" };
    const meta = await env.MUSIC_BUCKET.head(key);
    const totalSize = meta?.size ?? 0;
    if (totalSize > MAX_REWRITE_BYTES) return { written: false, reason: "file too large to rewrite" };

    let head = new Uint8Array(await headObj.arrayBuffer());
    const need = requiredPrefixLen(head, suffix);
    if (need === null) return { written: false, reason: "unsupported tag layout" };
    if (need > head.length) {
      const bigger = await env.MUSIC_BUCKET.get(key, { range: { offset: 0, length: need } });
      if (!bigger) return { written: false, reason: "object not found" };
      head = new Uint8Array(await bigger.arrayBuffer());
    }
    const rw = rebuildTagPrefix(head, suffix, tags, cover);
    if (!rw) return { written: false, reason: "unsupported tag layout" };

    const restLen = totalSize - rw.oldPrefixLen;
    const out = new Uint8Array(rw.newPrefix.length + restLen);
    out.set(rw.newPrefix, 0);
    if (restLen > 0) {
      const rest = await env.MUSIC_BUCKET.get(key, { range: { offset: rw.oldPrefixLen } });
      if (!rest) return { written: false, reason: "object not found" };
      out.set(new Uint8Array(await rest.arrayBuffer()), rw.newPrefix.length);
    }
    await env.MUSIC_BUCKET.put(key, out, {
      httpMetadata: meta?.httpMetadata || { contentType: contentType || "application/octet-stream" },
    });
    return { written: true, newSize: out.length };
  }

  if (uri.startsWith("webdav://")) {
    const rest = uri.substring(9);
    const slash = rest.indexOf("/");
    const src = sources.get(rest.substring(0, slash));
    if (!src) return { written: false, reason: "source not found or disabled" };
    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const url = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "") + "/" + encodePath(rest.substring(slash + 1));
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;

    // WebDAV has no cheap prefix swap — fetch the whole file, rewrite, PUT back
    const resp = await fetch(url, { headers: { Authorization: auth } });
    if (!resp.ok) return { written: false, reason: `GET failed: HTTP ${resp.status}` };
    const len = parseInt(resp.headers.get("Content-Length") || "0", 10);
    if (len > MAX_REWRITE_BYTES) {
      await resp.body?.cancel();
      return { written: false, reason: "file too large to rewrite" };
    }
    const whole = new Uint8Array(await resp.arrayBuffer());
    if (whole.length > MAX_REWRITE_BYTES) return { written: false, reason: "file too large to rewrite" };

    const need = requiredPrefixLen(whole, suffix);
    if (need === null || need > whole.length) return { written: false, reason: "unsupported tag layout" };
    const rw = rebuildTagPrefix(whole, suffix, tags);
    if (!rw) return { written: false, reason: "unsupported tag layout" };

    const out = new Uint8Array(rw.newPrefix.length + (whole.length - rw.oldPrefixLen));
    out.set(rw.newPrefix, 0);
    out.set(whole.subarray(rw.oldPrefixLen), rw.newPrefix.length);

    const put = await fetch(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": contentType || "application/octet-stream" },
      body: out,
    });
    if (!put.ok) return { written: false, reason: `PUT failed: HTTP ${put.status}` };
    return { written: true, newSize: out.length };
  }

  return { written: false, reason: "read-only source" };
}

// subsonic://) are silently skipped. Errors are swallowed by the caller.

/** Derive the sidecar path for a given song instance: same directory, same
 *  base name, with `newExt` substituted. Returns null for unsupported schemes. */
function deriveSidecarPath(storageUri: string, newExt: string): string | null {
  const lastSlash = storageUri.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const file = storageUri.substring(lastSlash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.substring(0, dot) : file;
  return storageUri.substring(0, lastSlash + 1) + base + "." + newExt;
}

/** Write D1 lyrics to `<songDir>/<songBase>.lrc` next to the instance. */
async function exportLrcSidecar(
  env: Env,
  sources: Map<string, SourceRow>,
  storageUri: string,
  lyrics: string,
): Promise<void> {
  const lrcUri = deriveSidecarPath(storageUri, "lrc");
  if (!lrcUri) return;
  const data = new TextEncoder().encode(lyrics);
  if (lrcUri.startsWith("r2://")) {
    await env.MUSIC_BUCKET.put(lrcUri.substring(5), data, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    return;
  }
  if (lrcUri.startsWith("webdav://")) {
    const rest = lrcUri.substring(9);
    const slash = rest.indexOf("/");
    const src = sources.get(rest.substring(0, slash));
    if (!src) return;
    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const url = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "") + "/" + encodePath(rest.substring(slash + 1));
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;
    await fetch(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "text/plain; charset=utf-8" },
      body: data,
    });
    return;
  }
  // url://, subsonic:// — read-only, skip silently.
}

/** Write R2 cover bytes to `<songDir>/cover.jpg` next to the instance. */
async function exportCoverSidecar(
  env: Env,
  sources: Map<string, SourceRow>,
  storageUri: string,
  coverBytes: Uint8Array,
): Promise<void> {
  const lastSlash = storageUri.lastIndexOf("/");
  if (lastSlash < 0) return;
  const coverUri = storageUri.substring(0, lastSlash + 1) + "cover.jpg";
  if (coverUri.startsWith("r2://")) {
    await env.MUSIC_BUCKET.put(coverUri.substring(5), coverBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    return;
  }
  if (coverUri.startsWith("webdav://")) {
    const rest = coverUri.substring(9);
    const slash = rest.indexOf("/");
    const src = sources.get(rest.substring(0, slash));
    if (!src) return;
    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const url = src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "") + "/" + encodePath(rest.substring(slash + 1));
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;
    await fetch(url, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "image/jpeg" },
      body: coverBytes,
    });
    return;
  }
  // url://, subsonic:// — read-only, skip silently.
}
