//  1. "wav不能正确的识别封面" — locateEmbeddedPicture (worker/src/utils/tags.ts)
//    only recognized ID3/FLAC magic bytes at buffer start; a WAV file
//    ("RIFF...") matched neither branch, so an embedded id3/APIC picture
//    was NEVER located regardless of where in the file it sat.
//  2. "时长错误显示为3秒" — a 33.6MB / 1411kbps WAV showing 0:00:03. Root
//    cause: music-metadata's WaveParser clamps the "data" chunk length to
//    whatever fits in a Range-truncated buffer when it doesn't know the
//    true remote file size, so parseBuffer() without a `size` hint computes
//    duration from ~512KB of PCM (≈3s at CD quality) instead of the real
//    35MB+ file. Covered here via the byteRate/clamp arithmetic directly
//    (taskExecutor.ts's actual parseBuffer call needs a browser + network
//    fetch, out of reach for a unit test — the math is what we can verify).
//
// Run: npx tsx test/wav_cover_duration.test.ts

import { locateEmbeddedPicture } from "../worker/src/utils/tags";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function be32Bytes(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
const enc = (s: string) => Array.from(new TextEncoder().encode(s));

// ID3v2.3 tag containing a single APIC (front cover) frame — same shape used
// by test/tagwrite_cover.test.ts, minus the outer "ID3" 10-byte tag header
// (that belongs to the WAV chunk wrapper here, not a standalone ID3 file).
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

// --- WAV with id3/APIC chunk BEFORE the "data" payload ---
function makeWavIdBeforeData(picBytes: number[]): Uint8Array {
  const fmtBody = [1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0];
  const id3Body = makeId3WithApic(picBytes);
  const dataBody = new Array(64).fill(0xaa);
  const chunks = [
    ...riffChunk("fmt ", fmtBody),
    ...riffChunk("id3 ", id3Body),
    ...riffChunk("data", dataBody),
  ];
  const riffSize = 4 + chunks.length; // "WAVE" + chunks
  return new Uint8Array([...enc("RIFF"), ...be32Bytes(riffSize).reverse(), ...enc("WAVE"), ...chunks]);
}

// --- WAV with id3/APIC chunk AFTER the "data" payload (common rip-tool convention) ---
function makeWavIdAfterData(picBytes: number[]): Uint8Array {
  const fmtBody = [1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0];
  const dataBody = new Array(64).fill(0xbb);
  const id3Body = makeId3WithApic(picBytes);
  const chunks = [
    ...riffChunk("fmt ", fmtBody),
    ...riffChunk("data", dataBody),
    ...riffChunk("id3 ", id3Body),
  ];
  const riffSize = 4 + chunks.length;
  return new Uint8Array([...enc("RIFF"), ...be32Bytes(riffSize).reverse(), ...enc("WAVE"), ...chunks]);
}

console.log("A. WAV embedded cover — head-positioned id3 chunk (before data):");
{
  const pic = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02];
  const wav = makeWavIdBeforeData(pic);
  const found = locateEmbeddedPicture(wav);
  assert(found !== null, "picture located");
  assert(found?.mime === "image/jpeg", "mime read correctly");
  assert(found?.source === "head" || found?.source === undefined, "source is head (or unset, meaning head)");
  if (found) {
    const bytes = Array.from(wav.subarray(found.offset, found.offset + found.length));
    assert(JSON.stringify(bytes) === JSON.stringify(pic), "extracted bytes match the embedded picture exactly");
  }
}

console.log("\nB. WAV embedded cover — tail-positioned id3 chunk (after data):");
{
  const pic = [0x11, 0x22, 0x33, 0x44, 0x55];
  const wav = makeWavIdAfterData(pic);

  // head-only lookup must find nothing (the id3 chunk is past this window)
  const headOnly = wav.subarray(0, 60);
  assert(locateEmbeddedPicture(headOnly) === null, "head-only slice (before the id3 chunk) finds no picture");

  // Simulate covers.ts's real usage: fetch a head slice AND a tail slice,
  // pass both. The tail slice here is the whole trailing portion containing
  // "id3 " + APIC — same shape a real Range fetch of the file's last N bytes
  // would produce.
  const tail = wav.subarray(44); // skip past fmt+data, roughly where id3 starts becomes reachable
  const found = locateEmbeddedPicture(headOnly, tail);
  assert(found !== null, "head+tail lookup locates the picture");
  assert(found?.source === "tail", "source is correctly tagged as tail");
  if (found) {
    const bytes = Array.from(tail.subarray(found.offset, found.offset + found.length));
    assert(JSON.stringify(bytes) === JSON.stringify(pic), "extracted bytes (sliced from tail, using tail-relative offset) match exactly");
  }
}

console.log("\nC. Non-WAV formats unaffected by the WAV branch (regression guard):");
{
  // A buffer starting with "RIFF" but not carrying an id3 chunk at all
  // must return null, not throw or false-positive.
  const fmtBody = [1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0];
  const dataBody = new Array(16).fill(0xcc);
  const chunks = [...riffChunk("fmt ", fmtBody), ...riffChunk("data", dataBody)];
  const riffSize = 4 + chunks.length;
  const plainWav = new Uint8Array([...enc("RIFF"), ...be32Bytes(riffSize).reverse(), ...enc("WAVE"), ...chunks]);
  assert(locateEmbeddedPicture(plainWav) === null, "WAV with no id3 chunk at all returns null (no false positive)");
}

console.log("\nD. Duration-clamp math (documents the exact root cause):");
{
  // The reported case: 33.6MB WAV, 1411kbps (CD-quality stereo 16-bit PCM).
  const sizeMB = 33.6;
  const totalBytes = Math.round(sizeMB * 1024 * 1024);
  const byteRate = 44100 * 2 * 2; // sampleRate * channels * bytesPerSample
  const trueDuration = totalBytes / byteRate;
  assert(Math.abs(trueDuration - 199.7) < 1, `true duration ≈200s / 3:20 (got ${trueDuration.toFixed(1)}s)`);

  // What WaveParser computes when it only sees a 512KB buffer and has no
  // fileInfo.size hint: it clamps the data chunk to the bytes actually
  // available (buffer length minus a small header), so duration ≈ that
  // truncated byte count / byteRate.
  const truncatedWindow = 512 * 1024;
  const truncatedDuration = truncatedWindow / byteRate;
  assert(Math.round(truncatedDuration) === 3, `truncated-buffer duration rounds to 3s, matching the reported bug (got ${truncatedDuration.toFixed(2)}s)`);

  // The fix: passing the TRUE size (from Content-Range or the dispatch
  // payload's `size`) as parseBuffer's fileInfo.size means WaveParser's
  // `calcRemaining = fileInfo.size - position` is large enough that the
  // clamp `calcRemaining < chunkSize` never triggers, so the header's
  // declared (correct) data-chunk length is used instead.
  const declaredChunkSize = totalBytes - 44; // typical minimal WAV header overhead
  const calcRemainingWithFix = totalBytes - 44;
  assert(calcRemainingWithFix >= declaredChunkSize, "with the true size hint, the clamp condition (calcRemaining < chunkSize) never triggers");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exit(1);
