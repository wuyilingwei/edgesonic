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

// Tag write-back via metadata-prefix rewrite.
// ID3v2 (mp3) and FLAC keep all metadata at the file head, so editing tags
// means: build a new prefix, then write newPrefix + originalBytes[oldPrefixLen..].
// Frames/blocks we don't edit (APIC, PICTURE, SEEKTABLE…) are copied verbatim.

import type { SongTags } from "./tags";

export interface PrefixRewrite {
  oldPrefixLen: number;
  newPrefix: Uint8Array;
}

/** Replacement front-cover image. mime must be image/jpeg or image/png; data ≤500KB enforced at endpoint. */
export interface TagWriteCover {
  mime: string;
  data: Uint8Array;
}

/** Total byte length of the metadata prefix, or null if format unsupported.
 *  Callers must hand `rebuildTagPrefix` a head slice of at least this length. */
export function requiredPrefixLen(head: Uint8Array, suffix: string): number | null {
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    let len = 10 + syncsafe(head, 6);
    if (head[5] & 0x10) len += 10; // v2.4 footer
    return len;
  }
  if (head.length >= 8 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    let pos = 4;
    for (;;) {
      if (pos + 4 > head.length) return null; // need a bigger slice
      const isLast = (head[pos] & 0x80) !== 0;
      const size = (head[pos + 1] << 16) | (head[pos + 2] << 8) | head[pos + 3];
      pos += 4 + size;
      if (isLast) return pos;
    }
  }
  if (suffix === "mp3") return 0; // bare mp3 without ID3 — prepend a fresh tag
  return null;
}

/** Build the replacement prefix. `head` must cover the whole old prefix.
 *  Returns null when the file layout is one we refuse to touch (unsync flag,
 *  extended header, truncated slice) — caller falls back to DB-only update.
 *  When `cover` is provided, the front-cover (APIC type 3 / PICTURE type 3) is
 *  replaced; other picture types (back cover, artist…) are kept. */
export function rebuildTagPrefix(head: Uint8Array, suffix: string, tags: SongTags, cover?: TagWriteCover): PrefixRewrite | null {
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return rebuildID3(head, tags, cover);
  }
  if (head.length >= 8 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    return rebuildFLAC(head, tags, cover);
  }
  if (suffix === "mp3") {
    return { oldPrefixLen: 0, newPrefix: buildID3Tag(3, [], tags, cover) };
  }
  return null;
}

// --- ID3v2 ---

const REPLACED_FRAMES = new Set(["TIT2", "TPE1", "TPE2", "TALB", "TCON", "TRCK", "TYER", "TDRC"]);

function rebuildID3(buf: Uint8Array, tags: SongTags, cover?: TagWriteCover): PrefixRewrite | null {
  const major = buf[3];
  const flags = buf[5];
  if (major !== 3 && major !== 4) return null;
  if (flags & 0x80) return null; // unsynchronised tag — copying frames raw would corrupt
  if (flags & 0x40) return null; // extended header — rare, skip rather than mis-copy
  const size = syncsafe(buf, 6);
  let oldPrefixLen = 10 + size;
  if (flags & 0x10) oldPrefixLen += 10; // footer
  if (oldPrefixLen > buf.length) return null;

  // Collect frames we keep (everything not being replaced, e.g. APIC, USLT).
  // Flag bytes are preserved verbatim — they dictate the body layout
  // (grouping byte, data-length indicator, per-frame unsync).
  const kept: Array<{ id: string; f1: number; f2: number; body: Uint8Array }> = [];
  const end = 10 + size;
  let pos = 10;
  while (pos + 10 <= end) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // hit padding
    const frameSize = major === 4 ? syncsafe(buf, pos + 4) : be32(buf, pos + 4);
    if (frameSize <= 0 || pos + 10 + frameSize > end) break;
    const body = buf.subarray(pos + 10, pos + 10 + frameSize);
    let replaced = REPLACED_FRAMES.has(id) && frameValueProvided(id, tags);
    // When a new cover is supplied, drop the existing front-cover APIC (picture
    // type 3) so we don't ship two front-cover frames. Other APIC types (back
    // cover, artist photo…) are preserved.
    if (!replaced && cover && id === "APIC" && isFrontCoverAPIC(body)) replaced = true;
    if (!replaced) {
      kept.push({ id, f1: buf[pos + 8], f2: buf[pos + 9], body });
    }
    pos += 10 + frameSize;
  }

  return { oldPrefixLen, newPrefix: buildID3Tag(major, kept, tags, cover) };
}

// APIC layout: enc(1) + mime(latin1 NUL) + picture_type(1) + description(NUL terminated) + data
// We only need the first 1+mime+1+1 bytes to read the picture type.
function isFrontCoverAPIC(body: Uint8Array): boolean {
  if (body.length < 3) return false;
  let p = 1; // skip encoding byte
  while (p < body.length && body[p] !== 0) p++;
  p++; // skip mime NUL
  if (p >= body.length) return false;
  return body[p] === 3;
}

function frameValueProvided(id: string, tags: SongTags): boolean {
  switch (id) {
    case "TIT2": return !!tags.title;
    case "TPE1": return !!tags.artist;
    case "TPE2": return !!tags.albumArtist;
    case "TALB": return !!tags.album;
    case "TCON": return !!tags.genre;
    case "TRCK": return !!tags.track;
    case "TYER": case "TDRC": return !!tags.year;
    default: return false;
  }
}

function buildID3Tag(major: 3 | 4 | number, kept: Array<{ id: string; f1: number; f2: number; body: Uint8Array }>, tags: SongTags, cover?: TagWriteCover): Uint8Array {
  const frames: Uint8Array[] = [];
  const text = (id: string, value: string) => frames.push(textFrame(major, id, value));

  if (tags.title) text("TIT2", tags.title);
  if (tags.artist) text("TPE1", tags.artist);
  if (tags.albumArtist) text("TPE2", tags.albumArtist);
  if (tags.album) text("TALB", tags.album);
  if (tags.genre) text("TCON", tags.genre);
  if (tags.track) text("TRCK", String(tags.track));
  if (tags.year) text(major === 4 ? "TDRC" : "TYER", String(tags.year));

  // Put the new front-cover APIC first so the canonical reader (which returns
  // the first APIC it finds) always sees the latest cover. Kept frames — back
  // cover, lyrics, etc. — follow.
  if (cover) frames.push(buildAPICFrame(major, cover));

  for (const f of kept) {
    const header = new Uint8Array(10);
    for (let i = 0; i < 4; i++) header[i] = f.id.charCodeAt(i);
    writeFrameSize(header, 4, f.body.length, major);
    header[8] = f.f1; header[9] = f.f2;
    frames.push(concat([header, f.body]));
  }

  const PADDING = 512;
  const bodyLen = frames.reduce((n, f) => n + f.length, 0) + PADDING;
  const out = new Uint8Array(10 + bodyLen);
  out[0] = 0x49; out[1] = 0x44; out[2] = 0x33; out[3] = major; out[4] = 0; out[5] = 0;
  writeSyncsafe(out, 6, bodyLen);
  let pos = 10;
  for (const f of frames) { out.set(f, pos); pos += f.length; }
  return out;
}

// APIC frame body: enc(1=latin1) + mime(latin1) + NUL + picture_type(=3 front) + desc NUL + image
function buildAPICFrame(major: number, cover: TagWriteCover): Uint8Array {
  const mimeBytes = new TextEncoder().encode(cover.mime);
  const bodyLen = 1 + mimeBytes.length + 1 + 1 + 1 + cover.data.length;
  const body = new Uint8Array(bodyLen);
  let p = 0;
  body[p++] = 0; // text encoding (latin1) — applies to description only
  body.set(mimeBytes, p); p += mimeBytes.length;
  body[p++] = 0; // mime NUL
  body[p++] = 3; // picture type = front cover
  body[p++] = 0; // empty description NUL
  body.set(cover.data, p);

  const out = new Uint8Array(10 + body.length);
  out[0] = 0x41; out[1] = 0x50; out[2] = 0x49; out[3] = 0x43; // "APIC"
  writeFrameSize(out, 4, body.length, major);
  out[8] = 0; out[9] = 0;
  out.set(body, 10);
  return out;
}

function textFrame(major: number, id: string, value: string): Uint8Array {
  // v2.3 → UTF-16 with BOM (enc 1); v2.4 → UTF-8 (enc 3)
  let body: Uint8Array;
  if (major === 4) {
    const data = new TextEncoder().encode(value);
    body = new Uint8Array(1 + data.length + 1);
    body[0] = 3;
    body.set(data, 1);
  } else {
    body = new Uint8Array(1 + 2 + value.length * 2 + 2);
    body[0] = 1; body[1] = 0xff; body[2] = 0xfe;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      body[3 + i * 2] = code & 0xff;
      body[4 + i * 2] = code >> 8;
    }
  }
  const out = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  writeFrameSize(out, 4, body.length, major);
  out.set(body, 10);
  return out;
}

function writeFrameSize(buf: Uint8Array, off: number, size: number, major: number): void {
  if (major === 4) writeSyncsafe(buf, off, size);
  else { buf[off] = (size >>> 24) & 0xff; buf[off + 1] = (size >>> 16) & 0xff; buf[off + 2] = (size >>> 8) & 0xff; buf[off + 3] = size & 0xff; }
}

// --- FLAC ---

const REPLACED_COMMENTS = new Set(["TITLE", "ARTIST", "ALBUM", "ALBUMARTIST", "GENRE", "TRACKNUMBER", "DATE", "YEAR"]);

function rebuildFLAC(buf: Uint8Array, tags: SongTags, cover?: TagWriteCover): PrefixRewrite | null {
  // Walk metadata blocks; keep everything but VORBIS_COMMENT verbatim.
  // When a cover is supplied, also drop the existing front-cover PICTURE
  // (type=6 / picture_type=3) so the new one doesn't duplicate it.
  const blocks: Array<{ type: number; body: Uint8Array }> = [];
  let oldVorbis: Uint8Array | null = null;
  let pos = 4;
  for (;;) {
    if (pos + 4 > buf.length) return null;
    const isLast = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (pos + 4 + size > buf.length) return null;
    const body = buf.subarray(pos + 4, pos + 4 + size);
    if (type === 4) oldVorbis = body;
    else if (type === 6 && cover && isFrontCoverFLAC(body)) {
      // skip — replaced by the new front cover below
    } else {
      blocks.push({ type, body });
    }
    pos += 4 + size;
    if (isLast) break;
  }
  const oldPrefixLen = pos;

  const vorbis = buildVorbisComment(oldVorbis, tags);
  if (vorbis.length >= 1 << 24) return null;
  const picture = cover ? buildFLACPictureBlock(cover) : null;
  if (picture && picture.length >= 1 << 24) return null;

  // STREAMINFO stays first; the rebuilt VORBIS_COMMENT goes right after it,
  // and the new PICTURE (if any) right after that.
  const ordered: Array<{ type: number; body: Uint8Array }> = [];
  for (const b of blocks) {
    ordered.push(b);
    if (b.type === 0 && !ordered.some((x) => x.type === 4)) {
      ordered.push({ type: 4, body: vorbis });
      if (picture) ordered.push({ type: 6, body: picture });
    }
  }
  if (!ordered.some((x) => x.type === 4)) ordered.unshift({ type: 4, body: vorbis });
  if (picture && !ordered.some((x) => x.type === 6 && x.body === picture)) {
    // STREAMINFO was missing → vorbis sits at index 0; drop the picture in right after it
    const vcIdx = ordered.findIndex((x) => x.type === 4);
    ordered.splice(vcIdx + 1, 0, { type: 6, body: picture });
  }

  let total = 4;
  for (const b of ordered) total += 4 + b.body.length;
  const out = new Uint8Array(total);
  out[0] = 0x66; out[1] = 0x4c; out[2] = 0x61; out[3] = 0x43;
  let w = 4;
  ordered.forEach((b, i) => {
    out[w] = (b.type & 0x7f) | (i === ordered.length - 1 ? 0x80 : 0);
    out[w + 1] = (b.body.length >> 16) & 0xff;
    out[w + 2] = (b.body.length >> 8) & 0xff;
    out[w + 3] = b.body.length & 0xff;
    out.set(b.body, w + 4);
    w += 4 + b.body.length;
  });
  return { oldPrefixLen, newPrefix: out };
}

// PICTURE body: type(4 BE) + mime_len(4) + mime + desc_len(4) + desc + w(4) + h(4) + depth(4) + colors(4) + data_len(4) + data
function isFrontCoverFLAC(body: Uint8Array): boolean {
  if (body.length < 4) return false;
  return be32(body, 0) === 3;
}

function buildFLACPictureBlock(cover: TagWriteCover): Uint8Array {
  const mimeBytes = new TextEncoder().encode(cover.mime);
  const total = 4 + 4 + mimeBytes.length + 4 + 0 + 4 + 4 + 4 + 4 + 4 + cover.data.length;
  const out = new Uint8Array(total);
  let w = 0;
  const putBE32 = (v: number) => { out[w] = (v >>> 24) & 0xff; out[w + 1] = (v >>> 16) & 0xff; out[w + 2] = (v >>> 8) & 0xff; out[w + 3] = v & 0xff; w += 4; };
  putBE32(3);                       // picture type = front cover
  putBE32(mimeBytes.length);
  out.set(mimeBytes, w); w += mimeBytes.length;
  putBE32(0);                       // description length
  // (no description bytes)
  putBE32(0);                       // width
  putBE32(0);                       // height
  putBE32(0);                       // colour depth
  putBE32(0);                       // # colours (0 for non-indexed)
  putBE32(cover.data.length);
  out.set(cover.data, w);
  return out;
}

function buildVorbisComment(old: Uint8Array | null, tags: SongTags): Uint8Array {
  const enc = new TextEncoder();
  const entries: Uint8Array[] = [];
  let vendor = enc.encode("EdgeSonic");

  if (old) {
    // carry over vendor + comments whose keys we are not replacing
    const dec = new TextDecoder("utf-8");
    let pos = 0;
    const le32 = () => { const v = (old[pos] | (old[pos + 1] << 8) | (old[pos + 2] << 16) | (old[pos + 3] << 24)) >>> 0; pos += 4; return v; };
    if (old.length >= 4) {
      const vendorLen = le32();
      if (pos + vendorLen <= old.length) { vendor = old.subarray(pos, pos + vendorLen); pos += vendorLen; }
      if (pos + 4 <= old.length) {
        const count = le32();
        for (let i = 0; i < count && pos + 4 <= old.length; i++) {
          const len = le32();
          if (pos + len > old.length) break;
          const entry = old.subarray(pos, pos + len);
          pos += len;
          const kv = dec.decode(entry);
          const key = kv.substring(0, kv.indexOf("=")).toUpperCase();
          const replaced = REPLACED_COMMENTS.has(key) && commentValueProvided(key, tags);
          if (!replaced) entries.push(entry);
        }
      }
    }
  }

  const add = (key: string, value: string) => entries.push(enc.encode(`${key}=${value}`));
  if (tags.title) add("TITLE", tags.title);
  if (tags.artist) add("ARTIST", tags.artist);
  if (tags.album) add("ALBUM", tags.album);
  if (tags.albumArtist) add("ALBUMARTIST", tags.albumArtist);
  if (tags.genre) add("GENRE", tags.genre);
  if (tags.track) add("TRACKNUMBER", String(tags.track));
  if (tags.year) add("DATE", String(tags.year));

  let total = 4 + vendor.length + 4;
  for (const e of entries) total += 4 + e.length;
  const out = new Uint8Array(total);
  let w = 0;
  const putLE32 = (v: number) => { out[w] = v & 0xff; out[w + 1] = (v >> 8) & 0xff; out[w + 2] = (v >> 16) & 0xff; out[w + 3] = (v >> 24) & 0xff; w += 4; };
  putLE32(vendor.length); out.set(vendor, w); w += vendor.length;
  putLE32(entries.length);
  for (const e of entries) { putLE32(e.length); out.set(e, w); w += e.length; }
  return out;
}

function commentValueProvided(key: string, tags: SongTags): boolean {
  switch (key) {
    case "TITLE": return !!tags.title;
    case "ARTIST": return !!tags.artist;
    case "ALBUM": return !!tags.album;
    case "ALBUMARTIST": return !!tags.albumArtist;
    case "GENRE": return !!tags.genre;
    case "TRACKNUMBER": return !!tags.track;
    case "DATE": case "YEAR": return !!tags.year;
    default: return false;
  }
}

// --- shared ---

function syncsafe(buf: Uint8Array, off: number): number {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}
function writeSyncsafe(buf: Uint8Array, off: number, v: number): void {
  buf[off] = (v >>> 21) & 0x7f; buf[off + 1] = (v >>> 14) & 0x7f; buf[off + 2] = (v >>> 7) & 0x7f; buf[off + 3] = v & 0x7f;
}
function be32(buf: Uint8Array, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
