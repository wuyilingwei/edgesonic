// follow-up on 123 (WAV cover/metadata fix): "没找到信息的情况下所有格式都应该
// 拉取全歌找确认没有任何元信息字段" — when the head(+tail) scan window finds nothing, ALL
// formats (not just WAV) should fall back to fetching the entire file before concluding it
// truly has no metadata. A partial window can miss tags parked somewhere neither head nor
// tail reaches (e.g. a WAV whose id3/LIST chunk sits mid-file, or any format with an
// oversized header pushing tags past HEAD_BYTES).
//
// taskExecutor.ts runs `self.addEventListener(...)` at module load time (it's written to
// execute inside a dedicated Worker), so plain Node needs a `self` stub before importing it
// — same reason test/browser_lyrics_native_fallback.test.ts falls back to source-text
// assertions for the parts of this file that aren't a plain exported function. isMetaEmpty
// is a pure, exported function, so it gets real unit tests here instead.
//
// Run: npx tsx test/metadata_full_file_fallback.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// Minimal shape matching the fields isMetaEmpty actually reads off
// music-metadata's IAudioMetadata — avoids pulling in the real (heavy) type.
type FakeMeta = {
  common: {
    title?: string; artist?: string; album?: string; albumartist?: string;
    genre?: string[]; year?: number;
    track?: { no: number | null }; disk?: { no: number | null };
    picture?: Array<{ data?: Uint8Array; format?: string }>;
    lyrics?: unknown;
  };
  native: Record<string, Array<{ id: string; value: unknown }>>;
};

function meta(overrides: Partial<FakeMeta["common"]> = {}, native: FakeMeta["native"] = {}): FakeMeta {
  return { common: { ...overrides }, native };
}

async function main() {
  (globalThis as unknown as { self: { addEventListener: () => void } }).self = { addEventListener: () => {} };
  const { isMetaEmpty } = await import("../web/src/workers/taskExecutor");

  console.log("A. Genuinely empty metadata (no text, no picture, no lyrics) -> empty:");
  {
    assert(isMetaEmpty(meta() as never), "bare metadata with nothing set is empty");
  }

  console.log("\nB. Any single text field is enough to count as non-empty:");
  {
    assert(!isMetaEmpty(meta({ title: "Song" }) as never), "title alone -> not empty");
    assert(!isMetaEmpty(meta({ artist: "Artist" }) as never), "artist alone -> not empty");
    assert(!isMetaEmpty(meta({ album: "Album" }) as never), "album alone -> not empty");
    assert(!isMetaEmpty(meta({ year: 2024 }) as never), "year alone -> not empty");
    assert(!isMetaEmpty(meta({ track: { no: 3 } }) as never), "track number alone -> not empty");
  }

  console.log("\nC. Empty-string / empty-array fields still count as empty (no false positives):");
  {
    assert(isMetaEmpty(meta({ title: "", artist: "", genre: [] }) as never), "blank strings / empty genre array -> still empty");
  }

  console.log("\nD. An embedded picture alone is enough to count as non-empty:");
  {
    assert(!isMetaEmpty(meta({ picture: [{ data: new Uint8Array([1, 2, 3]), format: "image/jpeg" }] }) as never), "picture present -> not empty");
  }

  console.log("\nE. Lyrics reachable only via the native-tag fallback (116) also counts as non-empty:");
  {
    const withNativeLyrics = meta({}, { vorbis: [{ id: "UNSYNCEDLYRICS", value: "la la la" }] });
    assert(!isMetaEmpty(withNativeLyrics as never), "native-tag lyrics fallback -> not empty");
  }

  console.log("\nF. Full-file fallback wiring present in runMetadata (source check — see file header for why):");
  {
    const src = fs.readFileSync(path.resolve(__dirname, "../web/src/workers/taskExecutor.ts"), "utf-8");
    assert(src.includes("isMetaEmpty(meta)"), "runMetadata checks isMetaEmpty(meta) before falling back");
    assert(/headAlreadyHadWholeFile/.test(src), "skips the fallback when the head fetch already had the whole file");
    assert(/FULL_FETCH_CAP_BYTES/.test(src), "full-file fetch is capped to avoid OOM on pathological files");
    assert(/if \(fullMeta && !isMetaEmpty\(fullMeta\)\) meta = fullMeta;/.test(src),
      "only replaces the original (possibly-empty) result when the full-file parse actually found something");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
