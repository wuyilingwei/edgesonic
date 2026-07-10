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

// music-metadata's Vorbis/FLAC tag mapper only promotes the bare
// `LYRICS` field into `common.lyrics` (node_modules/music-metadata/lib/ogg/
// vorbis/VorbisTagMapper.js). `SYNCEDLYRICS`/`UNSYNCEDLYRICS` — common output
// of Mp3tag/MusicBee/foobar2000-style taggers, and exactly the field names
// worker/src/utils/tags.ts (109, server-side embedded scan) already
// recognises with priority SYNCEDLYRICS > LYRICS > UNSYNCEDLYRICS — never
// reach `common.lyrics` and silently vanish from both browser-side lyric
// extraction paths (041 local scan `extractMetadata()` and 052b worker pool
// `taskExecutor.ts runMetadata()`). `nativeLyricsFallback()` reads
// music-metadata's raw `native` tag dump (always populated, no extra parse
// option needed) as a fallback with the same priority as tags.ts.
//
// We import web/src/lib/metadata.ts directly — unlike workerPool.ts (which
// transitively pulls in Pinia/Vue), this file has no Vue import and only
// touches the `music-metadata` package's `parseBlob` type, so it loads fine
// under plain Node/tsx.
//
// Run: npx tsx test/browser_lyrics_native_fallback.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { nativeLyricsFallback, lyricsTagsToText } from "../web/src/lib/metadata";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function nativeOf(entries: Array<{ id: string; value: unknown }>): Record<string, Array<{ id: string; value: unknown }>> {
  return { vorbis: entries };
}

async function main() {
  console.log("plain LYRICS field:");
  {
    const out = nativeLyricsFallback(nativeOf([{ id: "LYRICS", value: "la la la" }]));
    assert(out === "la la la", `LYRICS picked up (got "${out}")`);
  }

  console.log("\nUNSYNCEDLYRICS field (music-metadata never maps this to common.lyrics):");
  {
    const out = nativeLyricsFallback(nativeOf([{ id: "UNSYNCEDLYRICS", value: "fallback lyrics" }]));
    assert(out === "fallback lyrics", `UNSYNCEDLYRICS picked up (got "${out}")`);
  }

  console.log("\nSYNCEDLYRICS field:");
  {
    const out = nativeLyricsFallback(nativeOf([{ id: "SYNCEDLYRICS", value: "[00:01.00]synced" }]));
    assert(out === "[00:01.00]synced", `SYNCEDLYRICS picked up (got "${out}")`);
  }

  console.log("\npriority: SYNCEDLYRICS > LYRICS > UNSYNCEDLYRICS, order-independent:");
  {
    const a = nativeLyricsFallback(nativeOf([
      { id: "LYRICS", value: "unsynced version" },
      { id: "SYNCEDLYRICS", value: "synced version" },
    ]));
    assert(a === "synced version", `SYNCEDLYRICS wins when it comes after LYRICS (got "${a}")`);
    const b = nativeLyricsFallback(nativeOf([
      { id: "SYNCEDLYRICS", value: "synced version" },
      { id: "LYRICS", value: "unsynced version" },
    ]));
    assert(b === "synced version", `SYNCEDLYRICS wins when it comes before LYRICS (got "${b}")`);
    const c = nativeLyricsFallback(nativeOf([
      { id: "UNSYNCEDLYRICS", value: "fallback"  },
      { id: "LYRICS", value: "plain" },
    ]));
    assert(c === "plain", `LYRICS beats UNSYNCEDLYRICS (got "${c}")`);
  }

  console.log("\ncase-insensitive tag id matching:");
  {
    const out = nativeLyricsFallback(nativeOf([{ id: "lyrics", value: "lowercase key" }]));
    assert(out === "lowercase key", `lowercase 'lyrics' id matched (got "${out}")`);
  }

  console.log("\nignores empty/whitespace-only values and non-string values:");
  {
    const a = nativeLyricsFallback(nativeOf([{ id: "LYRICS", value: "   " }]));
    assert(a === undefined, `whitespace-only value ignored (got "${a}")`);
    const b = nativeLyricsFallback(nativeOf([{ id: "LYRICS", value: 42 }]));
    assert(b === undefined, `non-string value ignored (got "${b}")`);
  }

  console.log("\nirrelevant fields / other tagTypes don't interfere:");
  {
    const out = nativeLyricsFallback({
      vorbis: [{ id: "TITLE", value: "Song C" }, { id: "UNSYNCEDLYRICS", value: "fallback lyrics" }],
      "ID3v2.3": [{ id: "TIT2", value: "unrelated" }],
    });
    assert(out === "fallback lyrics", `cross-tagType scan finds UNSYNCEDLYRICS (got "${out}")`);
  }

  console.log("\nundefined/empty native handled without throwing:");
  {
    assert(nativeLyricsFallback(undefined) === undefined, "undefined native → undefined");
    assert(nativeLyricsFallback({}) === undefined, "empty native → undefined");
  }

  console.log("\nlyricsTagsToText still takes priority when common.lyrics IS populated (no regression):");
  {
    const common = [{ text: "from common.lyrics" }];
    const primary = lyricsTagsToText(common) || nativeLyricsFallback(nativeOf([{ id: "LYRICS", value: "native fallback should not win" }]));
    assert(primary === "from common.lyrics", `common.lyrics wins over native fallback (got "${primary}")`);
  }

  console.log("\nproduction source drift guard:");
  {
    const metaSrc = fs.readFileSync(
      path.resolve(__dirname, "../web/src/lib/metadata.ts"),
      "utf-8",
    );
    assert(metaSrc.includes("export function nativeLyricsFallback"),
      "nativeLyricsFallback still exported from lib/metadata.ts");
    assert(metaSrc.includes("lyricsTagsToText(common.lyrics) || nativeLyricsFallback(meta.native)"),
      "extractMetadata() (041 local scan) wires the fallback in");

    const taskExecutorSrc = fs.readFileSync(
      path.resolve(__dirname, "../web/src/workers/taskExecutor.ts"),
      "utf-8",
    );
    assert(taskExecutorSrc.includes("nativeLyricsFallback"),
      "taskExecutor.ts (052b worker pool) imports/uses nativeLyricsFallback");
    assert(taskExecutorSrc.includes("lyricsTagsToText(meta.common.lyrics) || nativeLyricsFallback(meta.native)"),
      "runMetadata() wires the fallback in with the same precedence as 041");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
