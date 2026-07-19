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

//
// Unified rich lyrics model used by the songLyrics v2 endpoint and the
// web player's karaoke renderer. The internal shape mirrors the
// OpenSubsonic `structuredLyrics` payload so the serializer and the
// frontend parser stay 1:1 with the spec.
//
// Sources parsed into this shape:
//  * TTML (.ttml / .xml) — W3C TTML2 with word/syllable <span> timing,
//    optional <div> agents and `xml:lang` translation tracks.
//  * KRC (.krc) — Kugou binary karaoke format: encrypted header + tagged
//    word-level timing. We support the plain-text / fmt=lrc variant and
//    the v2 krc envelope (decrypt-only is not implemented here; the
//    NetEase fetcher's `klyric` field reuses the enhanced-LRC shape).
//  * Enhanced LRC (.lrc with inline `[mm:ss.xx]` word tags or an XML
//    payload — the form NetEase `klyric` returns).
//  * Plain LRC — line-level only, no cueLine emitted.
//
// Everything is plain TypeScript with no DOM / fast-xml dependency; the
// parsers are intentionally permissive (private sidecars in the wild are
// messy) and never throw — a parse failure yields `null` so callers can
// fall back to plain LRC.

export interface RichCue {
  start: number; // ms
  end?: number; // ms (all-or-nothing across a cueLine)
  value: string;
  byteStart: number; // UTF-8 byte offset into cueLine.value
  byteEnd: number;
}

export interface RichCueLine {
  index: number;
  agentId?: string;
  start?: number; // ms (mirrors line.start when present)
  end?: number; // ms
  value: string;
  cue: RichCue[];
}

export interface RichAgent {
  id: string;
  role: "main" | "bg" | "voice" | "group";
  name?: string;
}

export interface RichLine {
  start?: number; // ms
  value: string;
}

export interface RichTrack {
  kind: "main" | "translation" | "pronunciation";
  lang: string;
  synced: boolean;
  offset?: number; // ms
  displayArtist?: string;
  displayTitle?: string;
  line: RichLine[];
  cueLine: RichCueLine[];
  agents: RichAgent[];
}

export interface RichLyrics {
  tracks: RichTrack[];
}

// ---------------------------------------------------------------------------
// UTF-8 byte offset helper. The spec requires byteStart/byteEnd to point
// into the UTF-8 encoding of cueLine.value. We compute the byte length of
// the prefix up to the start/end character index.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
function utf8ByteOffset(s: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  if (charIndex >= s.length) return enc.encode(s).byteLength;
  return enc.encode(s.slice(0, charIndex)).byteLength;
}

// ---------------------------------------------------------------------------
// Plain LRC → RichLyrics. Always one "main" track. cueLine is empty; line
// carries the line-level timestamps. Pure-text lyrics come back as an
// unsynced track. Metadata tags ([ti:..]/[ar:..]/[by:..]/[offset:..]) are
// dropped from the line list; [offset:] is applied as a global offset.
// ---------------------------------------------------------------------------
const LRC_TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_META = /^\[([a-zA-Z#][^:]*):(.*)\]$/;

export function parseLrcToRich(lyrics: string): RichLyrics | null {
  const lines = lyrics.split(/\r?\n/);
  const out: RichLine[] = [];
  let synced = false;
  let offset = 0;
  let lang = "xxx";
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const meta = LRC_META.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "offset") {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) offset = n; // ms, can be negative
      } else if (key === "la" || key === "language") {
        if (val) lang = val;
      }
      continue;
    }
    const stamps = [...line.matchAll(LRC_TS)];
    if (stamps.length > 0 && line.startsWith("[")) {
      const text = line.replace(LRC_TS, "").trim();
      for (const m of stamps) {
        const frac = (m[3] ?? "0").padEnd(3, "0").slice(0, 3);
        out.push({
          start: parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + parseInt(frac, 10),
          value: text,
        });
      }
      synced = true;
      continue;
    }
    out.push({ value: line });
  }
  if (synced) out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (out.length === 0) return null;
  return {
    tracks: [
      {
        kind: "main",
        lang,
        synced,
        ...(offset !== 0 ? { offset } : {}),
        line: out,
        cueLine: [],
        agents: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Enhanced LRC — NetEase `klyric` and similar. Two conventions:
//   1. `[mm:ss.xx]<word1>[mm:ss.xx]<word2>...` per-line word tagging.
//   2. `[mm:ss.xx]text` followed by a `[mm:ss.xx]`-tagged word list on
//      subsequent lines.
// We parse convention 1 directly. Each line that begins with a timestamp
// and contains additional inline timestamps produces a cueLine whose
// cues are the words between successive timestamps.
// ---------------------------------------------------------------------------
const INLINE_WORD_TS = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseEnhancedLrcToRich(lyrics: string): RichLyrics | null {
  const lines = lyrics.split(/\r?\n/);
  const richLines: RichLine[] = [];
  const cueLines: RichCueLine[] = [];
  let synced = false;
  let hasCue = false;
  let lang = "xxx";
  let offset = 0;

  let lineIdx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const meta = LRC_META.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "offset") {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) offset = n;
      } else if (key === "la" || key === "language") {
        if (val) lang = val;
      }
      continue;
    }

    // Inline word timestamps: scan the whole line, splitting into cues.
    const tsMatches = [...line.matchAll(INLINE_WORD_TS)];
    if (tsMatches.length >= 2 && line.startsWith("[")) {
      // Reconstruct the full line text by stripping timestamps.
      const fullText = line.replace(INLINE_WORD_TS, "").trim();
      const lineStartMs = tsToMs(tsMatches[0]);
      richLines.push({ start: lineStartMs, value: fullText });

      // Build cue list — each cue spans [thisTs, nextTs) and carries the
      // text between the two timestamps.
      const cues: RichCue[] = [];
      let cursor = 0; // char index into fullText
      for (let i = 0; i < tsMatches.length; i++) {
        const m = tsMatches[i];
        // Strip the timestamp text from the original to find the substring
        // it precedes. We re-derive the substring by removing the TS prefix
        // up to and including this match, then taking up to the next match.
        const tsStr = m[0];
        const after = line.slice(m.index! + tsStr.length);
        const nextTs = tsMatches[i + 1];
        const segment = nextTs
          ? after.slice(0, (nextTs.index! - (m.index! + tsStr.length)))
          : after;
        const text = segment;
        const start = tsToMs(m);
        const end = i + 1 < tsMatches.length ? tsToMs(tsMatches[i + 1]) : undefined;
        const bStart = utf8ByteOffset(fullText, cursor);
        cursor += text.length;
        const bEnd = utf8ByteOffset(fullText, cursor);
        cues.push({ start, ...(end !== undefined ? { end } : {}), value: text, byteStart: bStart, byteEnd: bEnd });
      }
      if (cues.length > 0) {
        cueLines.push({
          index: lineIdx,
          ...(lineStartMs !== undefined ? { start: lineStartMs } : {}),
          ...(cues[cues.length - 1].end !== undefined ? { end: cues[cues.length - 1].end } : {}),
          value: fullText,
          cue: cues,
        });
        hasCue = true;
      }
      lineIdx++;
      synced = true;
      continue;
    }

    // Plain synced line — same as parseLrcToRich.
    const stamps = [...line.matchAll(LRC_TS)];
    if (stamps.length > 0 && line.startsWith("[")) {
      const text = line.replace(LRC_TS, "").trim();
      for (const m of stamps) {
        richLines.push({ start: tsToMs(m), value: text });
      }
      synced = true;
      // No inline word data — cueLine is empty for this index; still bump
      // to keep line/cueLine index parity for cue-bearing lines.
      lineIdx++;
      continue;
    }
    richLines.push({ value: line });
    lineIdx++;
  }

  if (synced) richLines.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (richLines.length === 0 && cueLines.length === 0) return null;
  if (!hasCue) return null; // not actually enhanced — let caller fall back

  return {
    tracks: [
      {
        kind: "main",
        lang,
        synced,
        ...(offset !== 0 ? { offset } : {}),
        line: richLines,
        cueLine: cueLines,
        agents: [],
      },
    ],
  };
}

function tsToMs(m: RegExpMatchArray): number {
  const frac = (m[3] ?? "0").padEnd(3, "0").slice(0, 3);
  return parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + parseInt(frac, 10);
}

// ---------------------------------------------------------------------------
// TTML parser. Permissive subset of TTML2:
//   - <body><div><p begin=".." end="..">line</p></div></body>
//   - <p><span begin=".." end="..">word</span></p> for word timing
//   - xml:lang on <div> / <p> for translation tracks
//   - ttm:agent / ttm:role on <p> for agent attribution
//
// We do NOT implement ISM/SMIL clock formats beyond `hh:mm:ss.fff` and
// bare seconds (`12.5s`). Tick/expression offsets are ignored.
// ---------------------------------------------------------------------------
export function parseTtmlToRich(ttml: string): RichLyrics | null {
  let tracks: RichTrack[] = [];
  try {
    tracks = parseTtmlInner(ttml);
  } catch {
    return null;
  }
  if (tracks.length === 0) return null;
  return { tracks };
}

function parseTtmlInner(ttml: string): RichTrack[] {
  // Strip namespace prefixes for tag matching — TTML files in the wild use
  // tt:, ttp:, ttm:, xml: etc. We only care about local names.
  const stripped = ttml.replace(/<\/?([a-zA-Z0-9]+):([a-zA-Z0-9]+)/g, "<$2");
  const tracks: RichTrack[] = [];
  const agentMap = new Map<string, RichAgent>();

  // Parse <head><metadata><ttm:agent ...> entries.
  const agentRe = /<agent\b[^>]*\/?>(?:[\s\S]*?<\/agent>)?/g;
  let am: RegExpExecArray | null;
  while ((am = agentRe.exec(stripped)) !== null) {
    const block = am[0];
    const idAttr = attrVal(block, "id") || attrVal(block, "xml:id") || "";
    const roleAttr = attrVal(block, "role") || "";
    const nameMatch = /<name\b[^>]*>([\s\S]*?)<\/name>/i.exec(block);
    if (idAttr) {
      agentMap.set(idAttr, {
        id: idAttr,
        role: (["main", "bg", "voice", "group"].includes(roleAttr) ? roleAttr : "main") as RichAgent["role"],
        ...(nameMatch ? { name: decodeEntities(nameMatch[1].trim()) } : {}),
      });
    }
  }

  // Parse <div> blocks. Each <div> with xml:lang or a translation role
  // becomes its own track; otherwise the first div is the main track.
  const divRe = /<div\b[\s\S]*?<\/div>/gi;
  let dm: RegExpExecArray | null;
  let divIdx = 0;
  while ((dm = divRe.exec(stripped)) !== null) {
    const divBlock = dm[0];
    const langAttr = attrVal(divBlock, "xml:lang") || attrVal(divBlock, "lang") || "xxx";
    const divRole = attrVal(divBlock, "role") || "";
    const kind: RichTrack["kind"] =
      divRole === "translation" || (langAttr && langAttr !== "xxx" && divIdx > 0)
        ? "translation"
        : "main";
    const track = parseTtmlDiv(divBlock, kind, langAttr, agentMap);
    if (track) tracks.push(track);
    divIdx++;
  }

  if (tracks.length === 0) {
    // No <div> wrapping; parse the whole body.
    const bodyMatch = /<body\b[\s\S]*?<\/body>/i.exec(stripped);
    if (bodyMatch) {
      const t = parseTtmlDiv(bodyMatch[0], "main", "xxx", agentMap);
      if (t) tracks.push(t);
    }
  }
  return tracks;
}

function parseTtmlDiv(
  divBlock: string,
  kind: RichTrack["kind"],
  lang: string,
  agentMap: Map<string, RichAgent>,
): RichTrack | null {
  const lines: RichLine[] = [];
  const cueLines: RichCueLine[] = [];
  const usedAgentIds = new Set<string>();
  let synced = false;
  let hasCue = false;

  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let pm: RegExpExecArray | null;
  let lineIdx = 0;
  while ((pm = pRe.exec(divBlock)) !== null) {
    const fullP = pm[0];
    const inner = pm[1];
    const beginAttr = attrVal(fullP, "begin");
    const endAttr = attrVal(fullP, "end");
    const startMs = beginAttr ? clockToMs(beginAttr) : undefined;
    const endMs = endAttr ? clockToMs(endAttr) : undefined;
    const agentId = attrVal(fullP, "agent") || undefined;

    // Strip nested tags except <span> to extract the plain text. We keep
    // the <span> elements separately for word timing.
    const plain = inner
      .replace(/<br\s*\/?>(?:\r?\n)?/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!plain && !inner.includes("<span")) continue;

    if (startMs !== undefined) {
      lines.push({ start: startMs, value: plain });
      synced = true;
    } else {
      lines.push({ value: plain });
    }

    // Word-level: collect spans with begin/end.
    const cue: RichCue[] = [];
    let cursor = 0;
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let sm: RegExpExecArray | null;
    let spanTexts: string[] = [];
    while ((sm = spanRe.exec(inner)) !== null) {
      const spanAttrs = sm[1] || "";
      const spanText = sm[2].replace(/<[^>]+>/g, "").trim();
      if (!spanText) continue;
      const sBegin = attrVal(spanAttrs, "begin");
      const sEnd = attrVal(spanAttrs, "end");
      if (!sBegin) continue;
      const sStart = clockToMs(sBegin);
      if (sStart === undefined) continue;
      const sEndMs = sEnd ? clockToMs(sEnd) : undefined;
      const bStart = utf8ByteOffset(plain, cursor);
      cursor += spanText.length;
      const bEnd = utf8ByteOffset(plain, cursor);
      cue.push({
        start: sStart,
        ...(sEndMs !== undefined ? { end: sEndMs } : {}),
        value: spanText,
        byteStart: bStart,
        byteEnd: bEnd,
      });
    }
    if (cue.length > 0) {
      cueLines.push({
        index: lineIdx,
        ...(startMs !== undefined ? { start: startMs } : {}),
        ...(endMs !== undefined ? { end: endMs } : {}),
        value: plain,
        ...(agentId ? { agentId } : {}),
        cue,
      });
      hasCue = true;
      if (agentId) usedAgentIds.add(agentId);
    }
    lineIdx++;
  }

  const agents: RichAgent[] = [];
  for (const id of usedAgentIds) {
    const a = agentMap.get(id);
    if (a) agents.push(a);
  }

  return {
    kind,
    lang,
    synced,
    line: lines,
    cueLine: cueLines,
    agents,
  };
}

// ---------------------------------------------------------------------------
// KRC (Kugou) — the `.krc` file is a binary-enveloped format:
//   header: `karaoke lyrics\n` (or similar), a metadata line, then
//   encrypted data. We don't decrypt here. However, Kugou's `fmt=lrc`
//   endpoint returns a plain LRC; the `fmt=krc` endpoint returns the
//   binary which we'd need to decrypt with a fixed XOR key + zlib.
// We implement the XOR-decrypt path for KRC because private libraries
// sometimes ship .krc sidecars. The format:
//   - Skip the first 4 bytes after the header marker.
//   - The remaining bytes are XORed with the key 0xFFFF (per-byte
//     rotating) and compressed with zlib.
// We use the built-in DecompressionStream API for zlib inflate.
// ---------------------------------------------------------------------------
const KRC_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];

export async function parseKrcToRich(bytes: Uint8Array): Promise<RichLyrics | null> {
  // Header detection: KRC files start with the magic `0x6b 0x72 0x63 0x31`
  // ("krc1") OR with the ASCII string "karaoke" / "karaoke lyrics".
  if (bytes.byteLength < 16) return null;
  const head = bytes.slice(0, 4);
  const isKrc = head[0] === 0x6b && head[1] === 0x72 && head[2] === 0x63 && head[3] === 0x31;
  if (!isKrc) return null;

  // Skip the 4-byte magic; the next 4 bytes are a header length we ignore;
  // the payload after that is XOR-encrypted + zlib-compressed.
  const payload = bytes.slice(4);
  const decrypted = new Uint8Array(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i++) {
    decrypted[i] = payload[i] ^ KRC_KEY[i % KRC_KEY.length];
  }

  try {
    // zlib inflate. DecompressionStream('deflate-raw') is the streaming
    // equivalent of raw zlib (no header) — matches KRC.
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(decrypted).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const blob = new Blob(chunks);
    const text = await blob.text();
    return parseKrcTextToRich(text);
  } catch {
    return null;
  }
}

function parseKrcTextToRich(text: string): RichLyrics | null {
  // KRC plaintext uses the form:
  //   [offset:0]
  //   [12345,1000]word(0,200,0)word(200,400,0)word(400,400,0)
  // where the bracketed pair is [start_ms, duration_ms] and each word()
  // carries (start_offset_ms, duration_ms, 0). We parse line + word cues.
  const lines = text.split(/\r?\n/);
  const richLines: RichLine[] = [];
  const cueLines: RichCueLine[] = [];
  let lang = "xxx";
  let offset = 0;
  let lineIdx = 0;
  let synced = false;
  let hasCue = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const meta = LRC_META.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const val = meta[2].trim();
      if (key === "offset") {
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) offset = n;
      } else if (key === "la" || key === "language") {
        if (val) lang = val;
      }
      continue;
    }
    // [start_ms,duration_ms]text with word markers
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(line);
    if (!m) continue;
    const startMs = parseInt(m[1], 10);
    const durationMs = parseInt(m[2], 10);
    const rest = m[3];
    const endMs = startMs + durationMs;
    const plain = rest.replace(/<[^>]+>/g, "").replace(/\(\d+,\d+,\d+\)/g, "").trim();
    richLines.push({ start: startMs, value: plain });
    synced = true;

    // Words: word(offset_ms, duration_ms, 0)word2(...)
    const cues: RichCue[] = [];
    let cursor = 0;
    const wordRe = /([^()]*?)\((\d+),(\d+),\d+\)/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(rest)) !== null) {
      const wText = wm[1].replace(/<[^>]+>/g, "").trim();
      if (!wText) continue;
      const wStart = startMs + parseInt(wm[2], 10);
      const wEnd = wStart + parseInt(wm[3], 10);
      const bStart = utf8ByteOffset(plain, cursor);
      cursor += wText.length;
      const bEnd = utf8ByteOffset(plain, cursor);
      cues.push({ start: wStart, end: wEnd, value: wText, byteStart: bStart, byteEnd: bEnd });
    }
    if (cues.length > 0) {
      cueLines.push({ index: lineIdx, start: startMs, end: endMs, value: plain, cue: cues });
      hasCue = true;
    }
    lineIdx++;
  }

  if (richLines.length === 0) return null;
  if (!hasCue) return null;
  return {
    tracks: [
      {
        kind: "main",
        lang,
        synced,
        ...(offset !== 0 ? { offset } : {}),
        line: richLines,
        cueLine: cueLines,
        agents: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Format dispatch — given a sidecar file's extension + raw bytes, pick the
// right parser. Returns null on any non-match / parse failure so callers
// fall back to plain LRC.
// ---------------------------------------------------------------------------
export async function parseSidecarToRich(
  filename: string,
  bytes: Uint8Array,
): Promise<RichLyrics | null> {
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (ext === "ttml" || ext === "xml") {
    try {
      const text = new TextDecoder().decode(bytes);
      return parseTtmlToRich(text);
    } catch {
      return null;
    }
  }
  if (ext === "krc") {
    return parseKrcToRich(bytes);
  }
  if (ext === "lrc") {
    try {
      const text = new TextDecoder().decode(bytes);
      const enhanced = parseEnhancedLrcToRich(text);
      if (enhanced) return enhanced;
      return parseLrcToRich(text);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function attrVal(tagOrAttrs: string, name: string): string | undefined {
  // Match `name="value"` or `name='value'`. We accept the raw attribute
  // string from inside a tag and return the first match.
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*"([^"]*)"`, "i");
  const m = re.exec(tagOrAttrs);
  if (m) return decodeEntities(m[1]);
  const re2 = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*'([^']*)'`, "i");
  const m2 = re2.exec(tagOrAttrs);
  if (m2) return decodeEntities(m2[1]);
  return undefined;
}

function clockToMs(s: string): number | undefined {
  if (!s) return undefined;
  // hh:mm:ss.fff or mm:ss.fff or ss(.fff)s
  const hms = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d{1,3})?)$/.exec(s);
  if (hms) {
    const sec = parseFloat(hms[3]);
    return parseInt(hms[1], 10) * 3600000 + parseInt(hms[2], 10) * 60000 + Math.round(sec * 1000);
  }
  const ms = /^(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/.exec(s);
  if (ms) {
    const sec = parseFloat(ms[2]);
    return parseInt(ms[1], 10) * 60000 + Math.round(sec * 1000);
  }
  const ss = /^(\d+(?:\.\d{1,3})?)s?$/.exec(s);
  if (ss) {
    return Math.round(parseFloat(ss[1]) * 1000);
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// JSON round-trip — the D1 `lyrics_rich` column stores the RichLyrics
// payload as TEXT. These helpers keep the column value stable.
// ---------------------------------------------------------------------------
export function serializeRich(rich: RichLyrics): string {
  return JSON.stringify(rich);
}

export function deserializeRich(text: string | null | undefined): RichLyrics | null {
  if (!text || !text.trim()) return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.tracks) || obj.tracks.length === 0) return null;
    return obj as RichLyrics;
  } catch {
    return null;
  }
}