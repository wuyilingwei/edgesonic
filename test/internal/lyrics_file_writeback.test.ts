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
// Coverage:
//  1. ID3v2.3 mp3: USLT frame present with correct encoding/lang/lyrics bytes
//  2. ID3v2.4 mp3: USLT frame in UTF-8 encoding
//  3. USLT frame replaces an existing USLT (no duplicate)
//  4. FLAC: LYRICS= comment written into VORBIS_COMMENT block
//  5. FLAC: existing LYRICS= comment is replaced, not duplicated
//  6. When lyrics not provided, no USLT/LYRICS frame added
//
// Run: npx tsx test/internal/lyrics_file_writeback.test.ts

import { rebuildTagPrefix, requiredPrefixLen } from "../../worker/src/utils/tagwrite";
import type { SongTags } from "../../worker/src/utils/tags";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// Byte-level helpers
// ---------------------------------------------------------------------------
function syncsafeBytes(v: number): number[] {
  return [(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
}
function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function le32Bytes(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
function enc(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/** Scan ID3 tag body for a frame with the given 4-char id. Returns the body bytes or null. */
function findID3Frame(buf: Uint8Array, id: string): Uint8Array | null {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const major = buf[3];
  const flags = buf[5];
  if (flags & 0x80) return null; // unsync not handled
  const tagSize = syncsafeInt(buf, 6);
  const end = Math.min(10 + tagSize, buf.length);
  let pos = 10;
  while (pos + 10 <= end) {
    const fid = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const fsize = major === 4 ? syncsafeInt(buf, pos + 4) : be32Int(buf, pos + 4);
    if (fsize <= 0 || pos + 10 + fsize > end) break;
    if (fid === id) return buf.subarray(pos + 10, pos + 10 + fsize);
    pos += 10 + fsize;
  }
  return null;
}

function syncsafeInt(buf: Uint8Array, off: number): number {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}
function be32Int(buf: Uint8Array, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/** Count occurrences of frame with given id in the ID3 tag. */
function countID3Frames(buf: Uint8Array, id: string): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const major = buf[3];
  const tagSize = syncsafeInt(buf, 6);
  const end = Math.min(10 + tagSize, buf.length);
  let pos = 10;
  let count = 0;
  while (pos + 10 <= end) {
    const fid = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const fsize = major === 4 ? syncsafeInt(buf, pos + 4) : be32Int(buf, pos + 4);
    if (fsize <= 0 || pos + 10 + fsize > end) break;
    if (fid === id) count++;
    pos += 10 + fsize;
  }
  return count;
}

/** Find a VORBIS_COMMENT key=value entry in a FLAC file. Returns value or null. */
function findFLACComment(buf: Uint8Array, key: string): string | null {
  if (buf.length < 4 || buf[0] !== 0x66) return null;
  let pos = 4;
  const dec = new TextDecoder("utf-8");
  const upperKey = key.toUpperCase() + "=";
  while (pos + 4 <= buf.length) {
    const isLast = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (pos + 4 + size > buf.length) break;
    if (type === 4) {
      // VORBIS_COMMENT
      let p = pos + 4;
      const end = pos + 4 + size;
      if (p + 4 > end) return null;
      const vendorLen = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
      p += 4 + vendorLen;
      if (p + 4 > end) return null;
      const count = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
      p += 4;
      for (let i = 0; i < count && p + 4 <= end; i++) {
        const len = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
        p += 4;
        if (p + len > end) break;
        const entry = dec.decode(buf.subarray(p, p + len));
        p += len;
        if (entry.toUpperCase().startsWith(upperKey)) {
          return entry.substring(upperKey.length);
        }
      }
      return null;
    }
    pos += 4 + size;
    if (isLast) break;
  }
  return null;
}

/** Count occurrences of a VORBIS_COMMENT key in a FLAC file. */
function countFLACComments(buf: Uint8Array, key: string): number {
  if (buf.length < 4 || buf[0] !== 0x66) return 0;
  let pos = 4;
  const dec = new TextDecoder("utf-8");
  const upperKey = key.toUpperCase() + "=";
  let count = 0;
  while (pos + 4 <= buf.length) {
    const isLast = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (pos + 4 + size > buf.length) break;
    if (type === 4) {
      let p = pos + 4;
      const end = pos + 4 + size;
      const vendorLen = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
      p += 4 + vendorLen;
      const n = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
      p += 4;
      for (let i = 0; i < n && p + 4 <= end; i++) {
        const len = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
        p += 4;
        if (p + len > end) break;
        const entry = dec.decode(buf.subarray(p, p + len));
        p += len;
        if (entry.toUpperCase().startsWith(upperKey)) count++;
      }
      break;
    }
    pos += 4 + size;
    if (isLast) break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Synthetic file builders
// ---------------------------------------------------------------------------
function makeID3v3Mp3(withUSLT = false): Uint8Array {
  const titleBody = [0, ...enc("Test Song")];
  const titleFrame = [...enc("TIT2"), ...be32Bytes(titleBody.length), 0, 0, ...titleBody];
  const frames: number[] = [...titleFrame];
  if (withUSLT) {
    // existing USLT in UTF-8: enc(1=latin1?) — we'll use enc=0 latin1 for an "old" frame
    const usltBody = [0, 0x58, 0x58, 0x58, 0, ...enc("Old Lyrics")];
    frames.push(...enc("USLT"), ...be32Bytes(usltBody.length), 0, 0, ...usltBody);
  }
  const tag = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafeBytes(frames.length), ...frames];
  const audio = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3];
  return new Uint8Array([...tag, ...audio]);
}

function makeID3v4Mp3(): Uint8Array {
  const titleBody = [3, ...enc("Test Song v4")];
  const titleFrame = [...enc("TIT2"), ...syncsafeBytes(titleBody.length), 0, 0, ...titleBody];
  const tagBody = [...titleFrame];
  const tag = [0x49, 0x44, 0x33, 4, 0, 0, ...syncsafeBytes(tagBody.length), ...tagBody];
  const audio = [0xff, 0xfb, 0x90, 0x00, 5, 6, 7];
  return new Uint8Array([...tag, ...audio]);
}

function makeFlacWith(withLyrics = false): Uint8Array {
  const vendorBytes = enc("testvendor");
  const comments: number[][] = [
    [...enc("TITLE=My Song")],
  ];
  if (withLyrics) {
    comments.push([...enc("LYRICS=Old Lyrics")]);
  }
  const vcBody: number[] = [
    ...le32Bytes(vendorBytes.length), ...vendorBytes,
    ...le32Bytes(comments.length),
    ...comments.flatMap((c) => [...le32Bytes(c.length), ...c]),
  ];
  const streaminfo = new Array(34).fill(0x11);
  const block = (type: number, body: number[], last = false): number[] =>
    [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];

  const blocks = [
    ...block(0, streaminfo),   // STREAMINFO
    ...block(4, vcBody, true), // VORBIS_COMMENT (last)
  ];
  const audio = [0xf8, 0x00, 0x00, 0x00]; // dummy frame sync bytes
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...blocks, ...audio]);
}

function rewrite(file: Uint8Array, suffix: string, tags: SongTags): Uint8Array {
  const need = requiredPrefixLen(file, suffix);
  if (need === null) throw new Error(`requiredPrefixLen returned null for ${suffix}`);
  if (need > file.length) throw new Error(`need ${need} > file.length ${file.length}`);
  const rw = rebuildTagPrefix(file, suffix, tags);
  if (!rw) throw new Error("rebuildTagPrefix returned null");
  const out = new Uint8Array(rw.newPrefix.length + file.length - rw.oldPrefixLen);
  out.set(rw.newPrefix, 0);
  out.set(file.subarray(rw.oldPrefixLen), rw.newPrefix.length);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("USLT — ID3v2.3 mp3 lyrics write:");
{
  const file = makeID3v3Mp3();
  const out = rewrite(file, "mp3", { lyrics: "Line 1\nLine 2\nLine 3" });

  const uslt = findID3Frame(out, "USLT");
  assert(uslt !== null, "USLT frame present");
  if (uslt) {
    // v2.3 encoding = 1 (UTF-16)
    assert(uslt[0] === 1, `USLT encoding byte is 1 (UTF-16), got ${uslt[0]}`);
    // language bytes = 'XXX'
    assert(uslt[1] === 0x58 && uslt[2] === 0x58 && uslt[3] === 0x58, "USLT lang='XXX'");
    // descriptor is two-byte NUL (UTF-16 null)
    assert(uslt[4] === 0 && uslt[5] === 0, "USLT descriptor is UTF-16 NUL");
    // remaining bytes contain 'Line' in UTF-16 LE (BOM 0xFF 0xFE first)
    const rest = uslt.subarray(6);
    assert(rest[0] === 0xff && rest[1] === 0xfe, "UTF-16 BOM present");
    // Decode UTF-16LE (after BOM)
    const decoded = new TextDecoder("utf-16le").decode(rest.subarray(2));
    assert(decoded === "Line 1\nLine 2\nLine 3", `lyrics text correct (got "${decoded}")`);
  }
  assert(countID3Frames(out, "USLT") === 1, "exactly 1 USLT frame");
}

console.log("USLT — ID3v2.4 mp3 lyrics write (UTF-8):");
{
  const file = makeID3v4Mp3();
  const out = rewrite(file, "mp3", { lyrics: "日本語の歌詞" });

  const uslt = findID3Frame(out, "USLT");
  assert(uslt !== null, "USLT frame present in v2.4");
  if (uslt) {
    assert(uslt[0] === 3, `USLT encoding byte is 3 (UTF-8), got ${uslt[0]}`);
    assert(uslt[1] === 0x58 && uslt[2] === 0x58 && uslt[3] === 0x58, "USLT lang='XXX'");
    assert(uslt[4] === 0, "USLT descriptor NUL");
    const lyricsBytes = uslt.subarray(5);
    const decoded = new TextDecoder("utf-8").decode(lyricsBytes);
    assert(decoded === "日本語の歌詞", `UTF-8 lyrics correct (got "${decoded}")`);
  }
}

console.log("USLT — existing USLT replaced, not duplicated:");
{
  const file = makeID3v3Mp3(true); // has existing USLT
  const beforeCount = countID3Frames(file, "USLT");
  assert(beforeCount === 1, `fixture has 1 USLT (got ${beforeCount})`);

  const out = rewrite(file, "mp3", { lyrics: "New Lyrics Here" });
  const afterCount = countID3Frames(out, "USLT");
  assert(afterCount === 1, `exactly 1 USLT after rewrite (got ${afterCount})`);
  const uslt = findID3Frame(out, "USLT");
  if (uslt) {
    const rest = uslt.subarray(6); // skip enc(1) + lang(3) + desc_NUL_NUL(2)
    const decoded = new TextDecoder("utf-16le").decode(rest.subarray(2)); // skip BOM
    assert(decoded === "New Lyrics Here", `replaced lyrics correct (got "${decoded}")`);
  }
}

console.log("LYRICS — FLAC VORBIS_COMMENT write:");
{
  const file = makeFlacWith(false);
  const out = rewrite(file, "flac", { lyrics: "Verse 1\nVerse 2" });

  const val = findFLACComment(out, "LYRICS");
  assert(val !== null, "LYRICS comment present in FLAC");
  assert(val === "Verse 1\nVerse 2", `LYRICS value correct (got "${val}")`);
  assert(countFLACComments(out, "LYRICS") === 1, "exactly 1 LYRICS comment");
}

console.log("LYRICS — existing FLAC LYRICS replaced, not duplicated:");
{
  const file = makeFlacWith(true); // has existing LYRICS=
  const before = findFLACComment(file, "LYRICS");
  assert(before === "Old Lyrics", `fixture has LYRICS (got "${before}")`);

  const out = rewrite(file, "flac", { lyrics: "Updated Lyrics" });
  const after = findFLACComment(out, "LYRICS");
  assert(after === "Updated Lyrics", `LYRICS replaced correctly (got "${after}")`);
  assert(countFLACComments(out, "LYRICS") === 1, "no duplicate LYRICS comment");
}

console.log("No lyrics — no USLT/LYRICS frame added:");
{
  const mp3 = makeID3v3Mp3();
  const outMp3 = rewrite(mp3, "mp3", { title: "Just Title" });
  assert(countID3Frames(outMp3, "USLT") === 0, "no USLT when lyrics not provided (mp3)");

  const flac = makeFlacWith(false);
  const outFlac = rewrite(flac, "flac", { title: "Just Title" });
  assert(findFLACComment(outFlac, "LYRICS") === null, "no LYRICS comment when not provided (flac)");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
