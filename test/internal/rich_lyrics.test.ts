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
// Unit tests for the rich lyrics parser (0259). Covers:
//  * Plain LRC → single main track, line-level only, no cueLine.
//  * Enhanced LRC with inline word timestamps → cueLine + cue.
//  * TTML with <span begin/end> → cueLine + cue with byte offsets.
//  * TTML with xml:lang div → multiple tracks (main + translation).
//  * JSON round-trip via serialize/deserialize.
//
// Run: npx tsx test/internal/rich_lyrics.test.ts

import {
  parseLrcToRich,
  parseEnhancedLrcToRich,
  parseTtmlToRich,
  serializeRich,
  deserializeRich,
} from "../../worker/src/utils/richLyrics";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

console.log("Plain LRC → single main track:");
{
  const lrc = "[ti:Hello]\n[ar:Adele]\n[00:00.00]Hello, it's me\n[00:03.00]I was wondering";
  const rich = parseLrcToRich(lrc);
  assert(rich !== null, "parses");
  assert(rich!.tracks.length === 1, "single track");
  const t = rich!.tracks[0];
  assert(t.kind === "main", "kind=main");
  assert(t.synced === true, "synced");
  assert(t.line.length === 2, "two lines");
  assert(t.line[0].start === 0, "first start 0");
  assert(t.line[1].start === 3000, "second start 3000ms");
  assert(t.cueLine.length === 0, "no cueLine (plain LRC)");
  assert(t.agents.length === 0, "no agents");
  assert(t.lang === "xxx", "lang=xxx default");
}

console.log("\nPlain text (no timestamps) → unsynced track:");
{
  const rich = parseLrcToRich("verse one\nverse two");
  assert(rich !== null, "parses");
  assert(rich!.tracks[0].synced === false, "synced=false");
  assert(rich!.tracks[0].line.length === 2, "two lines");
  assert(rich!.tracks[0].line[0].value === "verse one", "first line text");
}

console.log("\nEnhanced LRC with inline word timestamps → cueLine:");
{
  // NetEase klyric-style: each word preceded by its own timestamp.
  const lrc =
    "[00:00.00]Hello [00:00.50]world [00:01.00]end\n[00:02.00]second line";
  const rich = parseEnhancedLrcToRich(lrc);
  assert(rich !== null, "parses enhanced");
  const t = rich!.tracks[0];
  assert(t.cueLine.length === 1, "one cueLine (only inline-tagged line)");
  assert(t.cueLine[0].cue.length === 3, "three cues");
  assert(t.cueLine[0].cue[0].value === "Hello ", "first cue text");
  assert(t.cueLine[0].cue[0].start === 0, "first cue start 0");
  assert(t.cueLine[0].cue[1].start === 500, "second cue start 500ms");
  assert(t.cueLine[0].cue[1].end === 1000, "second cue end 1000ms (next start)");
  assert(t.cueLine[0].cue[2].value === "end", "third cue text");
  assert(t.cueLine[0].cue[2].byteEnd > 0, "byteEnd > 0");
  assert(t.line.length === 2, "two lines total");
  assert(t.line[0].value === "Hello world end", "line 0 full text");
}

console.log("\nTTML with word-level <span> timing → cueLine:");
{
  const ttml = `<?xml version="1.0"?>
<tt xml:lang="en">
  <body>
    <div>
      <p begin="0s" end="2s">Hello <span begin="0s" end="0.5s">world</span> end</p>
      <p begin="2s" end="4s">second</p>
    </div>
  </body>
</tt>`;
  const rich = parseTtmlToRich(ttml);
  assert(rich !== null, "parses ttml");
  const t = rich!.tracks[0];
  assert(t.synced === true, "synced");
  assert(t.line.length === 2, "two lines");
  assert(t.line[0].start === 0, "line 0 start 0");
  assert(t.line[1].start === 2000, "line 1 start 2000ms");
  assert(t.cueLine.length === 1, "one cueLine (only first <p> has spans)");
  assert(t.cueLine[0].cue.length === 1, "one cue (only 'world' has timing)");
  assert(t.cueLine[0].cue[0].value === "world", "cue text");
  assert(t.cueLine[0].cue[0].start === 0, "cue start 0");
  assert(t.cueLine[0].cue[0].end === 500, "cue end 500ms");
}

console.log("\nTTML with xml:lang div → main + translation tracks:");
{
  const ttml = `<?xml version="1.0"?>
<tt xml:lang="ko">
  <body>
    <div xml:lang="ko">
      <p begin="1s">눈을 뜬 순간</p>
    </div>
    <div xml:lang="en">
      <p begin="1s">The moment I opened my eyes</p>
    </div>
  </body>
</tt>`;
  const rich = parseTtmlToRich(ttml);
  assert(rich !== null, "parses");
  assert(rich!.tracks.length === 2, "two tracks");
  assert(rich!.tracks[0].kind === "main", "first is main");
  assert(rich!.tracks[1].kind === "translation", "second is translation");
  assert(rich!.tracks[0].lang === "ko", "main lang=ko");
  assert(rich!.tracks[1].lang === "en", "translation lang=en");
  assert(rich!.tracks[1].line[0].value === "The moment I opened my eyes", "translation text");
}

console.log("\nJSON round-trip:");
{
  const lrc = "[00:00.00]first\n[00:01.00]second";
  const rich = parseLrcToRich(lrc)!;
  const json = serializeRich(rich);
  const back = deserializeRich(json);
  assert(back !== null, "deserialize succeeds");
  assert(back!.tracks.length === 1, "one track");
  assert(back!.tracks[0].line.length === 2, "two lines preserved");
  assert(back!.tracks[0].line[1].start === 1000, "start ms preserved");
}

console.log("\ndeserialize rejects malformed JSON:");
{
  assert(deserializeRich(null) === null, "null → null");
  assert(deserializeRich("") === null, "empty → null");
  assert(deserializeRich("not json") === null, "non-json → null");
  assert(deserializeRich("{}") === null, "no tracks → null");
  assert(deserializeRich('{"tracks":[]}') === null, "empty tracks → null");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);