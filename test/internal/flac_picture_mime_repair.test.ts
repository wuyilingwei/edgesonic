// FLAC PICTURE blocks with an empty MIME string (seen in Lavf-muxed release
// files) make Chrome's demuxer hard-fail the whole file. rebuildTagPrefix
// must heal such blocks during any prefix rewrite by sniffing the MIME from
// the image magic, while leaving healthy pictures byte-identical and unknown
// magics untouched.
// Run: npx tsx test/internal/flac_picture_mime_repair.test.ts

import { requiredPrefixLen, rebuildTagPrefix } from "../../worker/src/utils/tagwrite";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const be32Bytes = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
const block = (type: number, body: number[], last = false) =>
  [(type & 0x7f) | (last ? 0x80 : 0), (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff, ...body];

function picBody(picType: number, mime: string, data: number[]): number[] {
  return [
    ...be32Bytes(picType),
    ...be32Bytes(mime.length), ...enc(mime),
    ...be32Bytes(0),
    ...be32Bytes(0), ...be32Bytes(0), ...be32Bytes(0), ...be32Bytes(0),
    ...be32Bytes(data.length), ...data,
  ];
}

function makeFlac(pictureData: number[], mime: string): Uint8Array {
  const streaminfo = block(0, new Array(34).fill(0x11));
  const vendor = enc("Lavf58.45.100");
  const vcBody = [...le32(vendor.length), ...vendor, ...le32(1), ...le32(7), ...enc("TITLE=T")];
  const vc = block(4, vcBody);
  const pic = block(6, picBody(3, mime, pictureData));
  const padding = block(1, new Array(64).fill(0), true);
  const audio = [0xff, 0xf8, 0x59, 0x18];
  return new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...streaminfo, ...vc, ...pic, ...padding, ...audio]);
}

// Walk the rebuilt prefix and return each PICTURE's (mime, dataBytes).
function readPictures(file: Uint8Array): Array<{ mime: string; data: number[] }> {
  const out: Array<{ mime: string; data: number[] }> = [];
  let pos = 4;
  while (pos + 4 <= file.length) {
    const isLast = (file[pos] & 0x80) !== 0;
    const type = file[pos] & 0x7f;
    const size = (file[pos + 1] << 16) | (file[pos + 2] << 8) | file[pos + 3];
    if (type === 6) {
      const body = file.subarray(pos + 4, pos + 4 + size);
      let p = 4;
      const mlen = (body[p] << 24) | (body[p + 1] << 16) | (body[p + 2] << 8) | body[p + 3]; p += 4;
      const mime = new TextDecoder().decode(body.subarray(p, p + mlen)); p += mlen;
      const dlen = (body[p] << 24) | (body[p + 1] << 16) | (body[p + 2] << 8) | body[p + 3]; p += 4 + dlen;
      p += 16;
      const datalen = (body[p] << 24) | (body[p + 1] << 16) | (body[p + 2] << 8) | body[p + 3]; p += 4;
      out.push({ mime, data: Array.from(body.subarray(p, p + datalen)) });
    }
    pos += 4 + size;
    if (isLast) break;
  }
  return out;
}

function rewrite(file: Uint8Array): Uint8Array {
  const need = requiredPrefixLen(file, "flac");
  if (need === null || need > file.length) throw new Error("prefix len failed");
  const rw = rebuildTagPrefix(file, "flac", { title: "X" } as never);
  if (!rw) throw new Error("rebuild failed");
  const out = new Uint8Array(rw.newPrefix.length + file.length - rw.oldPrefixLen);
  out.set(rw.newPrefix, 0);
  out.set(file.subarray(rw.oldPrefixLen), rw.newPrefix.length);
  return out;
}

console.log("empty-MIME PICTURE with JPEG magic is healed:");
{
  const jpeg = [0xff, 0xd8, 0xff, 0xe1, 0x01, 0x02, 0x03];
  const out = rewrite(makeFlac(jpeg, ""));
  const pics = readPictures(out);
  assert(pics.length === 1, `one PICTURE survives (got ${pics.length})`);
  assert(pics[0]?.mime === "image/jpeg", `mime sniffed as image/jpeg (got ${JSON.stringify(pics[0]?.mime)})`);
  assert(JSON.stringify(pics[0]?.data) === JSON.stringify(jpeg), "image bytes intact");
  assert(out[out.length - 4] === 0xff && out[out.length - 3] === 0xf8, "audio frames preserved");
}

console.log("empty-MIME PICTURE with PNG magic is healed:");
{
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42];
  const pics = readPictures(rewrite(makeFlac(png, "")));
  assert(pics[0]?.mime === "image/png", `mime sniffed as image/png (got ${JSON.stringify(pics[0]?.mime)})`);
}

console.log("healthy PICTURE stays byte-identical:");
{
  const jpeg = [0xff, 0xd8, 0xff, 0xe1, 0x99];
  const before = makeFlac(jpeg, "image/jpeg");
  const pics = readPictures(rewrite(before));
  assert(pics[0]?.mime === "image/jpeg", "mime unchanged");
  assert(JSON.stringify(pics[0]?.data) === JSON.stringify(jpeg), "image bytes unchanged");
}

console.log("unknown image magic is left untouched:");
{
  const junk = [0x00, 0x01, 0x02, 0x03];
  const pics = readPictures(rewrite(makeFlac(junk, "")));
  assert(pics[0]?.mime === "", `mime still empty (got ${JSON.stringify(pics[0]?.mime)})`);
  assert(JSON.stringify(pics[0]?.data) === JSON.stringify(junk), "image bytes unchanged");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
