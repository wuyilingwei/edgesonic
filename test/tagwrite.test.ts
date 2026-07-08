// Round-trip tests for worker/src/utils/tagwrite.ts
// Build synthetic mp3/flac files → rewrite tags → re-parse with the production
// reader (tags.ts) → assert fields and byte-exact audio payload survival.
// Run: npx tsx test/tagwrite.test.ts

import { requiredPrefixLen, rebuildTagPrefix } from "../worker/src/utils/tagwrite";
import { parseTags, locateEmbeddedPicture } from "../worker/src/utils/tags";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function syncsafeBytes(v: number): number[] {
  return [(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
}
function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

// --- synthetic ID3v2.3 mp3 ---
function makeMp3(): Uint8Array {
  const enc = (s: string) => Array.from(new TextEncoder().encode(s));
  const frame = (id: string, text: string) => {
    const body = [0, ...enc(text)]; // enc=0 latin1/utf8-ish (smartDecode handles)
    return [...enc(id), ...be32Bytes(body.length), 0, 0, ...body];
  };
  const apicBody = [0, ...enc("image/jpeg"), 0, 3, ...enc("cover"), 0, 0xde, 0xad, 0xbe, 0xef];
  const apic = [...enc("APIC"), ...be32Bytes(apicBody.length), 0, 0, ...apicBody];
  const frames = [...frame("TIT2", "Old Title"), ...frame("TPE1", "Old Artist"), ...frame("TALB", "Old Album"), ...apic];
  const tag = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafeBytes(frames.length), ...frames];
  const audio = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return new Uint8Array([...tag, ...audio]);
}

// --- synthetic FLAC ---
function makeFlac(): Uint8Array {
  const enc = (s: string) => Array.from(new TextEncoder().encode(s));
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  const block = (type: number, body: number[], last = false) =>
    [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const streaminfo = block(0, new Array(34).fill(0x11));
  const vendor = enc("testvendor");
  const comments = ["TITLE=Old Title", "ARTIST=Old Artist", "CUSTOMKEY=keepme"].map(enc);
  const vcBody = [...le32(vendor.length), ...vendor, ...le32(comments.length),
    ...comments.flatMap((c) => [...le32(c.length), ...c])];
  const vc = block(4, vcBody);
  const padding = block(1, new Array(16).fill(0), true);
  const audio = [0xaa, 0xbb, 0xcc, 0xdd, 1, 2, 3, 4, 5];
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...streaminfo, ...vc, ...padding, ...audio]);
}

function rewrite(file: Uint8Array, suffix: string, tags: Record<string, unknown>): Uint8Array {
  const need = requiredPrefixLen(file, suffix);
  if (need === null || need > file.length) throw new Error("prefix len failed");
  const rw = rebuildTagPrefix(file, suffix, tags as never);
  if (!rw) throw new Error("rebuild failed");
  const out = new Uint8Array(rw.newPrefix.length + file.length - rw.oldPrefixLen);
  out.set(rw.newPrefix, 0);
  out.set(file.subarray(rw.oldPrefixLen), rw.newPrefix.length);
  return out;
}

console.log("ID3v2.3 mp3:");
{
  const file = makeMp3();
  const audioTail = file.subarray(file.length - 14);
  const before = parseTags(file);
  assert(before?.title === "Old Title" && before?.artist === "Old Artist", "fixture parses");

  const out = rewrite(file, "mp3", { title: "新标题", artist: "新歌手", year: 2024, track: 7 });
  const after = parseTags(out);
  assert(after?.title === "新标题", `title rewritten (got ${after?.title})`);
  assert(after?.artist === "新歌手", "artist rewritten (CJK via UTF-16)");
  assert(after?.album === "Old Album", "untouched TALB preserved");
  assert(after?.year === 2024 && after?.track === 7, "year/track added");
  const pic = locateEmbeddedPicture(out);
  assert(!!pic && out[pic.offset] === 0xde && out[pic.offset + 3] === 0xef, "APIC frame survives byte-exact");
  const outTail = out.subarray(out.length - 14);
  assert(audioTail.every((b, i) => b === outTail[i]), "audio payload byte-exact");
}

console.log("bare mp3 (no existing tag):");
{
  const bare = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 9, 8, 7]);
  const out = rewrite(bare, "mp3", { title: "Fresh" });
  const after = parseTags(out);
  assert(after?.title === "Fresh", "tag prepended");
  assert(out.subarray(out.length - 7).every((b, i) => b === bare[i]), "audio preserved");
}

console.log("FLAC:");
{
  const file = makeFlac();
  const audioTail = file.subarray(file.length - 9);
  const before = parseTags(file);
  assert(before?.title === "Old Title", "fixture parses");

  const out = rewrite(file, "flac", { title: "新曲名", album: "新专辑", genre: "Rock" });
  const after = parseTags(out);
  assert(after?.title === "新曲名", `title rewritten (got ${after?.title})`);
  assert(after?.album === "新专辑" && after?.genre === "Rock", "album/genre rewritten");
  assert(after?.artist === "Old Artist", "untouched ARTIST preserved");
  const outTail = out.subarray(out.length - 9);
  assert(audioTail.every((b, i) => b === outTail[i]), "audio payload byte-exact");
  assert(out[0] === 0x66 && out[1] === 0x4c, "fLaC magic intact");
  // exactly one block must carry the last-metadata flag, and it must be the final one
  let pos = 4, lastFlags: boolean[] = [];
  while (pos + 4 <= out.length) {
    const isLast = (out[pos] & 0x80) !== 0;
    const size = (out[pos + 1] << 16) | (out[pos + 2] << 8) | out[pos + 3];
    lastFlags.push(isLast);
    pos += 4 + size;
    if (isLast) break;
  }
  assert(lastFlags.filter(Boolean).length === 1 && lastFlags[lastFlags.length - 1], "last-block flag correct");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
