// Regression guard for a bug where getCoverArt (worker/src/endpoints/subsonic/
// media.ts -> covers.ts resolveAlbumCover) never located embedded cover art on
// WAV files whose "id3 "/APIC chunk sits after the (large) "data" payload,
// even though 111 already fixed the equivalent text-tag path (slices.ts grew
// its tail fetch from 128KB to 2MB for exactly this reason). covers.ts kept
// its own separate 256KB tail constant, so any WAV whose trailing id3+APIC
// chunk started more than 256KB before EOF was silently never found — this
// is common once the chunk itself embeds a picture of any real size.
//
// Run: npx tsx test/internal/wav_cover_tail_window.test.ts

import { extractEmbedded } from "../../worker/src/utils/covers";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
const enc = (s: string) => Array.from(new TextEncoder().encode(s));

function makeId3WithApic(picBytes: number[]): number[] {
  const apicBody = [0, ...enc("image/jpeg"), 0, 3, ...enc("cover"), 0, ...picBytes];
  const apicFrame = [...enc("APIC"), ...be32Bytes(apicBody.length), 0, 0, ...apicBody];
  const frameSize = apicFrame.length;
  const syncsafe = (v: number) => [(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f];
  return [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frameSize), ...apicFrame];
}

function riffChunk(id: string, body: number[]): number[] {
  const padded = body.length % 2 === 1 ? [...body, 0] : body;
  return [...enc(id.length === 4 ? id : id.padEnd(4)), ...be32Bytes(body.length).reverse(), ...padded];
}

// Builds a WAV whose trailing id3 chunk is the LAST chunk in the file (the
// common rip-tool convention), and whose embedded picture is big enough
// (300KB) that the chunk's own START sits more than 256KB before EOF — that
// start offset is exactly what locateWAVPictureTail scans forward from, so
// if it falls outside the fetched tail window the picture is never found at
// all, regardless of the picture's true size. Total file size is also padded
// well past the 2.25MB (HEAD_BYTES + WAV_TAIL_BYTES) threshold so the tail
// fetch actually fires.
function makeWavWithFarTailChunk(picBytes: number[]): Uint8Array {
  const fmtBody = [1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0];
  const PADDING_BYTES = 3 * 1024 * 1024;
  const dataBody = new Array(PADDING_BYTES).fill(0xaa);
  const id3Body = makeId3WithApic(picBytes);
  const chunks = [
    ...riffChunk("fmt ", fmtBody),
    ...riffChunk("data", dataBody),
    ...riffChunk("id3 ", id3Body),
  ];
  const riffSize = 4 + chunks.length;
  return new Uint8Array([...enc("RIFF"), ...be32Bytes(riffSize).reverse(), ...enc("WAVE"), ...chunks]);
}

async function main() {
  console.log("A. Trailing id3/APIC chunk whose own (300KB) size pushes its start past the old 256KB tail window:");
  {
    const pic = new Array(300 * 1024).fill(0).map((_, i) => i % 256);
    const wav = makeWavWithFarTailChunk(pic);

    const image = await extractEmbedded(async ({ offset, length }) => {
      const end = Math.min(offset + length, wav.length);
      if (offset >= wav.length) return new Uint8Array(0);
      return wav.subarray(offset, end);
    }, wav.length);

    assert(image !== null, "cover located through the fetchRange abstraction (mirrors R2/WebDAV range gets)");
    if (image) {
      assert(image.contentType === "image/jpeg", "mime read correctly");
      assert(JSON.stringify(Array.from(image.body)) === JSON.stringify(pic), "extracted bytes match the embedded picture exactly");
    }
  }

  console.log("\nB. Non-WAV formats keep the small (256KB) tail window (no wasted range GETs):");
  {
    let requestedTailLength: number | null = null;
    const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...new Array(20).fill(0)]); // "fLaC" + junk, no PICTURE block
    await extractEmbedded(async ({ offset, length }) => {
      if (offset > 0) requestedTailLength = length;
      return offset === 0 ? flac : new Uint8Array(0);
    }, 10 * 1024 * 1024);
    assert(requestedTailLength === 256 * 1024, `non-WAV tail fetch still requests 256KB (got ${requestedTailLength})`);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
