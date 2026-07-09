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

// ============================================================================
// Browser-side metadata extraction (task 041)
// ----------------------------------------------------------------------------
// Worker端 scanTags 只懂 MP3 / FLAC / WAV — 这里用 music-metadata v8+ 在浏览器
// 解析其余十几种格式（OGG/Opus/M4A/MP4/AAC/APE/WMA/AIFF/ALAC/DSF/DFF/WebM/...）
// 解析结果通过 /rest/submitMetadata 提交给后端落 D1。
// ============================================================================

import { parseBlob } from "music-metadata";

/** 后端 Worker 已经支持的后缀（不要走浏览器解析；让 scanTags 兜底）。*/
export const WORKER_SUPPORTED = new Set(["mp3", "flac", "wav"]);

/**
 * 浏览器侧 music-metadata 能处理的后缀（精挑：实际命中 EdgeSonic 用户库的格式）。
 * mp4/m4a/m4b/aac 共用一族容器；alac 通常装在 m4a 里，但也保留显式后缀以防万一。
 */
export const BROWSER_SUPPORTED = new Set([
  "ogg", "opus", "oga",
  "m4a", "m4b", "mp4", "aac",
  "ape", "wma", "asf",
  "aiff", "aif",
  "alac",
  "dsf", "dff",
  "webm",
]);

/** 从文件名提取小写后缀（无后缀返回空串）。 */
export function suffixOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 该后缀是否需要走浏览器侧解析（非空且不在 WORKER_SUPPORTED 集合）。 */
export function isBrowserParse(suffix: string): boolean {
  return BROWSER_SUPPORTED.has(suffix) && !WORKER_SUPPORTED.has(suffix);
}

// ============================================================================
// ExtractedMetadata — 落地到 /rest/submitMetadata 的 payload 形状
// ----------------------------------------------------------------------------
// 字段对齐策略（见 049/findings.md D + 041/findings.md）：
//   - logical：title/artist/album/albumArtist/genre/year/track/disc → song_masters
//   - physical：duration/bitrate/sampleRate/channels → song_instances
//   - lyrics：109 起持久化到 song_masters.lyrics（applyMetadataResult 用
//     COALESCE(NULLIF(lyrics,''), ?) 只填空列，不覆盖已有的用户编辑/外部抓取结果）
//   - container/codec：只用于诊断/未来回填；后端目前忽略
// ============================================================================
export interface ExtractedMetadata {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  track?: number;
  disc?: number;
  duration?: number;     // seconds
  bitrate?: number;      // kbps (music-metadata 返回 bps，这里已经 /1000)
  sampleRate?: number;   // Hz
  channels?: number;
  lyrics?: string;
  container?: string;
  codec?: string;
}

/**
 * 用 music-metadata 解析单个 File 对象。
 * 失败时抛错；调用方应 try/catch 并 toast 用户。
 */
export async function extractMetadata(file: File): Promise<ExtractedMetadata> {
  // skipCovers=true：041 不处理封面（封面由 042 接管）；省 RAM
  const meta = await parseBlob(file, { skipCovers: true, duration: true });
  const { format, common } = meta;

  const out: ExtractedMetadata = {};
  if (common.title) out.title = common.title;
  if (common.artist) out.artist = common.artist;
  if (common.album) out.album = common.album;
  if (common.albumartist) out.albumArtist = common.albumartist;
  if (common.genre && common.genre.length > 0) out.genre = common.genre[0];
  if (typeof common.year === "number") out.year = common.year;
  if (typeof common.track?.no === "number") out.track = common.track.no;
  if (typeof common.disk?.no === "number") out.disc = common.disk.no;

  if (typeof format.duration === "number") out.duration = Math.round(format.duration);
  if (typeof format.bitrate === "number") out.bitrate = Math.round(format.bitrate / 1000);
  if (typeof format.sampleRate === "number") out.sampleRate = format.sampleRate;
  if (typeof format.numberOfChannels === "number") out.channels = format.numberOfChannels;

  const ly = lyricsTagsToText(common.lyrics);
  if (ly) out.lyrics = ly;

  if (format.container) out.container = format.container;
  if (format.codec) out.codec = format.codec;

  return out;
}

// ============================================================================
// lyricsTagsToText — shared by extractMetadata() (this file, 041 local scan)
// and taskExecutor.ts (052b browser worker pool) so both paths flatten
// music-metadata's `common.lyrics` the same way.
// ----------------------------------------------------------------------------
// music-metadata's ILyricsTag shape: { text?, syncText?: {text,timestamp}[] }
// (some builds instead hand back a bare string[]). Preference order:
//   1. An entry with syncText → rebuild LRC `[mm:ss.xx]line` per timestamp so
//      the backend's parseLrc (worker/src/endpoints/subsonic/lyrics.ts, 108)
//      round-trips it back into per-line start offsets for Subsonic clients.
//      Before 109 we only joined the plain text, discarding every timestamp.
//   2. An entry with plain `.text`.
//   3. A bare string element.
// ============================================================================
export function lyricsTagsToText(lyrics: unknown): string | undefined {
  if (!Array.isArray(lyrics) || lyrics.length === 0) return undefined;
  for (const entry of lyrics) {
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (!entry || typeof entry !== "object") continue;
    const tag = entry as { text?: string; syncText?: Array<{ text?: string; timestamp?: number }> };
    if (Array.isArray(tag.syncText) && tag.syncText.length > 0) {
      const lines = tag.syncText
        .filter((l) => l.text && l.text.trim())
        .map((l) => `[${msToLrcTimestamp(l.timestamp ?? 0)}]${l.text!.trim()}`);
      if (lines.length > 0) return lines.join("\n");
    }
    if (tag.text && tag.text.trim()) return tag.text.trim();
  }
  return undefined;
}

function msToLrcTimestamp(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
