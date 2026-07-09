// Build synthetic mp3/flac files → rewrite with a fake JPEG/PNG payload →
// use the production reader (tags.ts) to locate the embedded picture and
// assert the bytes survived intact, and that prior non-front-cover frames
// (APIC type 4, FLAC PICTURE type 2) are preserved.
// Run: npx tsx test/tagwrite_cover.test.ts

import { requiredPrefixLen, rebuildTagPrefix } from "../worker/src/utils/tagwrite";
import { parseTags, locateEmbeddedPicture } from "../worker/src/utils/tags";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function syncsafeBytes(v: number): number[] {
  return [(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
}
function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
const enc = (s: string) => Array.from(new TextEncoder().encode(s));

// --- synthetic ID3v2.3 mp3 with an APIC type=3 (front cover) and a type=4 (back cover)
function makeMp3WithCovers(): Uint8Array {
  const frame = (id: string, text: string) => {
    const body = [0, ...enc(text)];
    return [...enc(id), ...be32Bytes(body.length), 0, 0, ...body];
  };
  const apicBody = (mime: string, picType: number, data: number[]) =>
    [0, ...enc(mime), 0, picType, ...enc("cover"), 0, ...data];
  const front = apicBody("image/jpeg", 3, [0x11, 0x22, 0x33]);
  const back = apicBody("image/png", 4, [0x44, 0x55]);
  const apicFront = [...enc("APIC"), ...be32Bytes(front.length), 0, 0, ...front];
  const apicBack = [...enc("APIC"), ...be32Bytes(back.length), 0, 0, ...back];
  const frames = [...frame("TIT2", "Title"), ...apicFront, ...apicBack];
  const tag = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafeBytes(frames.length), ...frames];
  const audio = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8];
  return new Uint8Array([...tag, ...audio]);
}

// --- synthetic FLAC with an existing front-cover PICTURE (type=3) and a back cover (type=4)
function makeFlacWithCovers(): Uint8Array {
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  const block = (type: number, body: number[], last = false) =>
    [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const picBody = (picType: number, mime: string, data: number[]) => [
    ...be32Bytes(picType),
    ...be32Bytes(mime.length), ...enc(mime),
    ...be32Bytes(0),                                    // empty description
    ...be32Bytes(0), ...be32Bytes(0), ...be32Bytes(0), ...be32Bytes(0),
    ...be32Bytes(data.length), ...data,
  ];
  const streaminfo = block(0, new Array(34).fill(0x11));
  const vendor = enc("v");
  const comments = ["TITLE=T", "ARTIST=A"].map(enc);
  const vcBody = [...le32(vendor.length), ...vendor, ...le32(comments.length),
    ...comments.flatMap((c) => [...le32(c.length), ...c])];
  const vc = block(4, vcBody);
  const oldFront = block(6, picBody(3, "image/jpeg", [0xAA, 0xBB]));
  const back = block(6, picBody(4, "image/png", [0xCC, 0xDD, 0xEE]), true);
  const audio = [0xa1, 0xb2, 0xc3, 0xd4];
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...streaminfo, ...vc, ...oldFront, ...back, ...audio]);
}

function rewrite(file: Uint8Array, suffix: string, tags: Record<string, unknown>, cover?: { mime: string; data: Uint8Array }): Uint8Array {
  const need = requiredPrefixLen(file, suffix);
  if (need === null || need > file.length) throw new Error("prefix len failed");
  const rw = rebuildTagPrefix(file, suffix, tags as never, cover);
  if (!rw) throw new Error("rebuild failed");
  const out = new Uint8Array(rw.newPrefix.length + file.length - rw.oldPrefixLen);
  out.set(rw.newPrefix, 0);
  out.set(file.subarray(rw.oldPrefixLen), rw.newPrefix.length);
  return out;
}

// Count APIC / PICTURE frames so we can assert the old front cover went away
// while non-front-cover entries survived.
function countID3PicturesByType(file: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const size = ((file[6] & 0x7f) << 21) | ((file[7] & 0x7f) << 14) | ((file[8] & 0x7f) << 7) | (file[9] & 0x7f);
  let pos = 10;
  const end = 10 + size;
  while (pos + 10 <= end) {
    const id = String.fromCharCode(file[pos], file[pos + 1], file[pos + 2], file[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = file[pos + 3] === 0
      ? 0
      : (((file[pos + 4] & 0x7f) << 21) | ((file[pos + 5] & 0x7f) << 14) | ((file[pos + 6] & 0x7f) << 7) | (file[pos + 7] & 0x7f));
    // We built v2.3 fixtures, so size is BE32 not syncsafe:
    const sz23 = (file[pos + 4] << 24) | (file[pos + 5] << 16) | (file[pos + 6] << 8) | file[pos + 7];
    const frameSize = sz23 > 0 ? sz23 : sz;
    if (frameSize <= 0 || pos + 10 + frameSize > end) break;
    if (id === "APIC") {
      // body: enc + mime NUL + picType + …
      let p = pos + 10 + 1;
      while (p < pos + 10 + frameSize && file[p] !== 0) p++;
      p++; // mime NUL
      const picType = file[p];
      out.set(picType, (out.get(picType) || 0) + 1);
    }
    pos += 10 + frameSize;
  }
  return out;
}

function countFLACPicturesByType(file: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  let pos = 4;
  while (pos + 4 <= file.length) {
    const isLast = (file[pos] & 0x80) !== 0;
    const type = file[pos] & 0x7f;
    const size = (file[pos + 1] << 16) | (file[pos + 2] << 8) | file[pos + 3];
    if (type === 6 && pos + 4 + size <= file.length) {
      const picType = (file[pos + 4] << 24) | (file[pos + 5] << 16) | (file[pos + 6] << 8) | file[pos + 7];
      out.set(picType, (out.get(picType) || 0) + 1);
    }
    pos += 4 + size;
    if (isLast) break;
  }
  return out;
}

console.log("ID3v2.3 mp3 with APIC cover writeback:");
{
  const file = makeMp3WithCovers();
  // pretend a new JPEG cover the UI pre-compressed via canvas (small fixture is fine)
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0x42), 0xff, 0xd9]);
  const out = rewrite(file, "mp3", { title: "Kept" }, { mime: "image/jpeg", data: coverBytes });

  const after = parseTags(out);
  assert(after?.title === "Kept", `title written (got ${after?.title})`);

  const pic = locateEmbeddedPicture(out);
  assert(!!pic, "front cover located");
  if (pic) {
    assert(pic.mime === "image/jpeg", `mime preserved (got ${pic.mime})`);
    assert(pic.length === coverBytes.length, `length matches (${pic.length} vs ${coverBytes.length})`);
    const data = out.subarray(pic.offset, pic.offset + pic.length);
    let ok = true;
    for (let i = 0; i < coverBytes.length; i++) if (data[i] !== coverBytes[i]) { ok = false; break; }
    assert(ok, "byte-exact cover payload");
  }

  const byType = countID3PicturesByType(out);
  assert(byType.get(3) === 1, `exactly one front-cover APIC (got ${byType.get(3)})`);
  assert(byType.get(4) === 1, `back-cover APIC preserved (got ${byType.get(4)})`);
}

console.log("ID3v2.3 mp3 with PNG cover:");
{
  const file = makeMp3WithCovers();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0x01)]);
  const out = rewrite(file, "mp3", { artist: "x" }, { mime: "image/png", data: png });
  const pic = locateEmbeddedPicture(out);
  assert(!!pic && pic.mime === "image/png", `png mime preserved (got ${pic?.mime})`);
  if (pic) {
    const data = out.subarray(pic.offset, pic.offset + pic.length);
    assert(data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47, "PNG magic intact");
  }
}

console.log("bare mp3 with cover:");
{
  const bare = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 9, 8, 7]);
  const data = new Uint8Array([0xab, 0xcd, 0xef, 0x12]);
  const out = rewrite(bare, "mp3", { title: "Fresh" }, { mime: "image/jpeg", data });
  const after = parseTags(out);
  assert(after?.title === "Fresh", "tag prepended");
  const pic = locateEmbeddedPicture(out);
  assert(!!pic, "APIC inserted into a fresh tag");
  assert(out.subarray(out.length - 7).every((b, i) => b === bare[i]), "audio preserved");
}

console.log("FLAC PICTURE block writeback:");
{
  const file = makeFlacWithCovers();
  const beforeByType = countFLACPicturesByType(file);
  assert(beforeByType.get(3) === 1 && beforeByType.get(4) === 1, "fixture has one front + one back PICTURE");

  const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04, 0xff, 0xd9]);
  const out = rewrite(file, "flac", { title: "X" }, { mime: "image/jpeg", data: cover });

  const pic = locateEmbeddedPicture(out);
  assert(!!pic, "front cover located in rebuilt FLAC");
  if (pic) {
    assert(pic.mime === "image/jpeg", `mime preserved (got ${pic.mime})`);
    assert(pic.length === cover.length, `length matches (${pic.length})`);
    const data = out.subarray(pic.offset, pic.offset + pic.length);
    let ok = true;
    for (let i = 0; i < cover.length; i++) if (data[i] !== cover[i]) { ok = false; break; }
    assert(ok, "byte-exact FLAC PICTURE payload");
  }

  const byType = countFLACPicturesByType(out);
  assert(byType.get(3) === 1, `exactly one front-cover PICTURE (got ${byType.get(3)})`);
  assert(byType.get(4) === 1, `back-cover PICTURE preserved (got ${byType.get(4)})`);

  // last-flag invariant survives
  let pos = 4, lastFlags: boolean[] = [];
  while (pos + 4 <= out.length) {
    const isLast = (out[pos] & 0x80) !== 0;
    const size = (out[pos + 1] << 16) | (out[pos + 2] << 8) | out[pos + 3];
    lastFlags.push(isLast);
    pos += 4 + size;
    if (isLast) break;
  }
  assert(lastFlags.filter(Boolean).length === 1 && lastFlags[lastFlags.length - 1], "last-block flag still on the trailing block");
}

console.log("FLAC without an existing cover gains one:");
{
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  const block = (type: number, body: number[], last = false) =>
    [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
  const vendor = enc("v");
  const vcBody = [...le32(vendor.length), ...vendor, ...le32(0)];
  const file = new Uint8Array([
    0x66, 0x4c, 0x61, 0x43,
    ...block(0, new Array(34).fill(0)),
    ...block(4, vcBody, true),
    1, 2, 3,
  ]);
  const cover = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
  const out = rewrite(file, "flac", { title: "Y" }, { mime: "image/jpeg", data: cover });
  const pic = locateEmbeddedPicture(out);
  assert(!!pic, "cover gained on a coverless FLAC");
  if (pic) {
    const data = out.subarray(pic.offset, pic.offset + pic.length);
    let ok = true;
    for (let i = 0; i < cover.length; i++) if (data[i] !== cover[i]) { ok = false; break; }
    assert(ok, "byte-exact payload on coverless FLAC");
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
