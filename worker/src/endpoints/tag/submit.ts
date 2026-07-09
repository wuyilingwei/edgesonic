// ============================================================================
// 041 — POST /rest/submitMetadata + GET /rest/findInstanceByUri
// ----------------------------------------------------------------------------
// 浏览器侧已经用 music-metadata 解析过一个本地音频文件，把解析结果发回来落 D1：
//   * 用 instanceId 反查 master_id
//   * 重链 artist/album（与 scanTags 派生方式一致：md5(name) 前 10 位）
//   * 更新 song_masters 的逻辑字段
//   * 更新 song_instances 的物理参数（bit_rate/sample_rate/channels/duration）
//   * 标记 tag_scanned = 1
//
// 077 — relinkArtistAlbum / SubmittedMetadata 已搬至 worker/src/utils/metadataApply.ts，
// 这里只做端点壳子：参数校验 → cleanInput → applyMetadataResult → 包成 041 既有响应。
// 对调用方（Files 浏览器）签名 / 返回字段全部保持兼容。本文件保留两符号的 re-export
// 给历史路径，避免外部代码迁移负担。
//
// 设计原则保持不变：
//   * 不调用 worker/src/utils/tags.ts → 041 的核心动机就是节约 Workers CPU
//   * 不复用 tagedit.applyTagsToSong → 那条路径会 rewriteInstance 强写文件，041 只落 D1
// ============================================================================

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import {
  applyMetadataResult,
  relinkArtistAlbum,
  type SubmittedMetadata,
} from "../../utils/metadataApply";

// Re-export so any caller historically pulling SubmittedMetadata / relinkArtistAlbum
// from "endpoints/tag/submit" keeps working — 077 only moved the source of truth.
export { relinkArtistAlbum, type SubmittedMetadata };

export const metadataRoutes = new Hono();

// ============================================================================
// GET /rest/findInstanceByUri?uri=r2://...|webdav://...
// ----------------------------------------------------------------------------
// Files.vue lists files by storage_uri; the browser-side scanner needs the
// matching song_instances.id to POST submitMetadata against. We expose a
// minimal lookup (exact match on storage_uri) instead of teaching the front-
// end to learn the master→instance relationship through Subsonic browsing.
// ============================================================================
metadataRoutes.get("/findInstanceByUri", permissionMiddleware("manage_sources"), async (c) => {
  const env = c.env as Env;
  const uri = c.req.query("uri");
  if (!uri) return c.json({ ok: false, error: "Missing uri" }, 400);
  const row = await env.DB.prepare(
    "SELECT id, master_id, suffix, tag_scanned FROM song_instances WHERE storage_uri = ?"
  ).bind(uri).first<{ id: string; master_id: string; suffix: string; tag_scanned: number }>();
  if (!row) return c.json({ ok: false, error: "Instance not found" }, 404);
  return c.json({
    ok: true,
    instanceId: row.id,
    masterId: row.master_id,
    suffix: row.suffix,
    tagScanned: row.tag_scanned,
  });
});

metadataRoutes.post("/submit", permissionMiddleware("edit_tags"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;

  const body = await c.req.json<{ instanceId?: string; tags?: SubmittedMetadata }>().catch(() => null);
  if (!body?.instanceId || !body.tags) {
    return c.json({ ok: false, error: "Missing instanceId or tags" }, 400);
  }

  const tags = cleanInput(body.tags);
  // At least one usable logical field must survive — otherwise we'd just bump
  // tag_scanned without learning anything (and a future scan couldn't retry).
  if (!hasAnyLogical(tags)) {
    return c.json({ ok: false, error: "No usable tag fields" }, 400);
  }

  // 077 — common + format both come from the same scrubbed SubmittedMetadata;
  // applyMetadataResult re-coerces internally but our pre-scrub is already
  // type-clean so the second pass is effectively a no-op.
  const res = await applyMetadataResult(db, body.instanceId, tags, tags);
  if (!res.updated) {
    const code = res.reason === "instance not found" ? 400
               : res.reason === "master not found"   ? 500
               : 400;
    return c.json({ ok: false, error: res.reason || "apply failed" }, code);
  }

  // 041 response shape included album/artist ids. The helper only returns
  // masterId so we look the freshly-relinked fk's up here. This adds one D1
  // read on the happy path — negligible vs. the work it just did.
  const ids = await db.prepare(
    "SELECT artist_id, album_id FROM song_masters WHERE id = ?",
  ).bind(res.masterId!).first<{ artist_id: string; album_id: string }>();

  return c.json({
    ok: true,
    masterId: res.masterId!,
    albumId: ids?.album_id,
    artistId: ids?.artist_id,
  });
});

// ============================================================================
// Input scrubbing — same shape as tagedit.cleanInput, plus the 041-only fields.
// Kept inline because /submit's 400 "No usable tag fields" guard depends on it
// running before applyMetadataResult (the helper would silently flip
// tag_scanned=1 with no other UPDATE — fine for /work/submit, NOT fine for an
// explicit user-driven /tag/submit call).
// ============================================================================
function cleanInput(t: SubmittedMetadata): SubmittedMetadata {
  const out: SubmittedMetadata = {};
  if (t.title?.trim())       out.title       = t.title.trim();
  if (t.artist?.trim())      out.artist      = t.artist.trim();
  if (t.album?.trim())       out.album       = t.album.trim();
  if (t.albumArtist?.trim()) out.albumArtist = t.albumArtist.trim();
  if (t.genre?.trim())       out.genre       = t.genre.trim();

  const track = Number(t.track), year = Number(t.year), disc = Number(t.disc);
  if (Number.isInteger(track) && track > 0) out.track = track;
  if (Number.isInteger(year)  && year  > 0) out.year  = year;
  if (Number.isInteger(disc)  && disc  > 0) out.disc  = disc;

  // physical params: any positive finite number is fine
  if (Number.isFinite(t.duration)   && (t.duration   as number) > 0) out.duration   = t.duration;
  if (Number.isFinite(t.bitrate)    && (t.bitrate    as number) > 0) out.bitrate    = t.bitrate;
  if (Number.isFinite(t.sampleRate) && (t.sampleRate as number) > 0) out.sampleRate = t.sampleRate;
  if (Number.isFinite(t.channels)   && (t.channels   as number) > 0) out.channels   = t.channels;

  // 109 — lyrics is persisted (applyMetadataResult, COALESCE-guarded so it
  // never overwrites an existing value); container/codec stay diagnostic-only.
  if (t.lyrics?.trim())    out.lyrics    = t.lyrics.trim();
  if (t.container?.trim()) out.container = t.container.trim();
  if (t.codec?.trim())     out.codec     = t.codec.trim();
  return out;
}

// 109 — lyrics counts as a usable field on its own: a re-scan that only
// turned up an embedded LYRICS/USLT tag (no title/artist change) must not
// 400 here, or the lyrics never reach applyMetadataResult at all.
function hasAnyLogical(t: SubmittedMetadata): boolean {
  return !!(t.title || t.artist || t.album || t.albumArtist || t.genre || t.year || t.track || t.disc || t.lyrics);
}
