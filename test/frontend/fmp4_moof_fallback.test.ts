// 116 — fragmented-MP4 lyrics fallback (web/src/workers/taskExecutor.ts).
//
// music-metadata (≤11.13.0) cannot parse some fMP4 .m4a files: it throws
// "Missing sampleDuration and no defaultSampleDuration in track fragment
// header" while walking `moof` fragments — after the complete tag set
// (moov/udta/ilst, including ©lyr lyrics) has physically been read. The
// worker now retries with the buffer truncated just before the first `moof`
// box, which lets the same parser return title/artist/album/lyrics/cover.
// Verified end-to-end against a production sample (si-650fb259bf, 神的女儿们):
// primary parse fails, truncated parse extracts lyrics + 212KB cover.
//
// This test covers the byte-scan helper's contract (firstMoofBoxStart) plus a
// source drift guard. The helper is re-implemented here because importing
// taskExecutor.ts directly would execute its top-level self.addEventListener
// calls, and `self` doesn't exist in plain Node (same constraint as
// task_executor_error_msg.test.ts).
//
// Run: npx tsx test/frontend/fmp4_moof_fallback.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// Re-declared — kept byte-identical to the source.
function firstMoofBoxStart(buf: Uint8Array): number {
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x66) {
      return i - 4;
    }
  }
  return -1;
}

const enc = new TextEncoder();
// Build a byte buffer from string/byte fragments.
function bytes(...parts: Array<string | number[]>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : new Uint8Array(p)));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function main() {
  console.log("firstMoofBoxStart — locates the box start (4 bytes before the 4CC):");
  {
    // [8-byte ftyp stub][4-byte size][moof]...
    const buf = bytes("....ftyp", [0, 0, 0, 16], "moofXXXXXXXX");
    const at = firstMoofBoxStart(buf);
    assert(at === 8, `box start at 8 (size field before 4CC) — got ${at}`);
  }

  console.log("\nno moof present → -1:");
  {
    const buf = bytes("....ftyp....moovAAAAAAAAAAAA");
    assert(firstMoofBoxStart(buf) === -1, "returns -1 for a non-fragmented layout");
    assert(firstMoofBoxStart(new Uint8Array(0)) === -1, "returns -1 for empty buffer");
    assert(firstMoofBoxStart(bytes("moo")) === -1, "returns -1 for tiny buffer");
  }

  console.log("\nmultiple moofs → first one wins:");
  {
    const buf = bytes("....ftyp", [0, 0, 0, 16], "moofAAAA", [0, 0, 0, 16], "moofBBBB");
    assert(firstMoofBoxStart(buf) === 8, "first fragment's box start returned");
  }

  console.log("\npartial 4CC ('moo' + other byte) is not a false positive:");
  {
    const buf = bytes("....ftypmoovmooXmoot", [0, 0, 0, 8], "moof");
    const at = firstMoofBoxStart(buf);
    assert(at === buf.length - 8, `only the real moof matches — got ${at}, want ${buf.length - 8}`);
  }

  console.log("\nsource drift guard:");
  {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../web/src/workers/taskExecutor.ts"),
      "utf-8",
    );
    assert(src.includes("function firstMoofBoxStart(buf: Uint8Array): number"),
      "firstMoofBoxStart still present in taskExecutor.ts");
    assert(src.includes("const cut = firstMoofBoxStart(buf);"),
      "parse fallback still calls firstMoofBoxStart");
    assert(/if \(cut <= 16\) \{[\s\S]{0,120}throw new Error/.test(src),
      "non-fMP4 errors still propagate (as the same wrapped error format the surrounding two-tier fallback already uses)");
    assert(/meta = await parseBuffer\(buf\.slice\(0, cut\)/.test(src),
      "fallback still re-parses the truncated slice");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed.");
}

main();
