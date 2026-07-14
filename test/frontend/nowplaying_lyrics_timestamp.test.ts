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

// getLyricsBySongId emits <structuredLyrics synced="true|false"><line
// start="8120">text</line>...</structuredLyrics> (worker/src/endpoints/
// subsonic/lyrics.ts) — the real per-line timestamp lives in the `start` ms
// XML attribute, and the server already strips any "[mm:ss]" bracket tag out
// of the line text before emitting it (see parseLrc there).
//
// NowPlaying.vue used to extract only the inner text of each <line> via
// `/<line[^>]*>([^<]*)<\/line>/g` (discarding the `start` attribute entirely)
// and hand the joined text to parseLrcDual(), which re-derives timestamps by
// scanning for literal "[mm:ss.xx]" brackets in the text — brackets that the
// server had already stripped. Every line's time therefore came back as 0,
// hasSynced was permanently false, and the auto-scroll / click-to-seek
// features never actually engaged even though their own code was correct.
// parseStructuredLines() fixes this by reading `start` directly.
//
// NowPlaying.vue is a .vue SFC and can't be imported directly under plain
// Node/tsx, so this test duplicates parseStructuredLines' algorithm exactly
// (kept in sync via the source-drift check at the bottom) rather than
// exercising the real function in-process — same tradeoff this repo already
// makes for web/src/workers/taskExecutor.ts in test/browser_lyrics_native_fallback.test.ts.
//
// Run: npx tsx test/frontend/nowplaying_lyrics_timestamp.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface LyricLine { time: number; text: string; tr?: string }

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Exact copy of NowPlaying.vue's parseStructuredLines — see file header.
function parseStructuredLines(inner: string): LyricLine[] {
  const lineRe = /<line(?:\s+start="(\d+)")?[^>]*>([^<]*)<\/line>/g;
  let m: RegExpExecArray | null;
  const raw: { time: number; text: string; hasTime: boolean }[] = [];
  while ((m = lineRe.exec(inner)) !== null) {
    const hasTime = m[1] !== undefined;
    const content = decodeEntities(m[2]).trim();
    if (!content) continue;
    raw.push({ time: hasTime ? parseInt(m[1], 10) / 1000 : 0, text: content, hasTime });
  }
  const hasTs = raw.some((r) => r.hasTime);
  if (!hasTs) {
    return raw.map((r) => ({ time: 0, text: r.text }));
  }
  const byTime = new Map<number, { text: string; tr?: string }>();
  const ordered: LyricLine[] = [];
  for (const r of raw) {
    const existing = byTime.get(r.time);
    if (existing) {
      if (!existing.tr) existing.tr = r.text;
    } else {
      const entry = { text: r.text, tr: undefined as string | undefined };
      byTime.set(r.time, entry);
      ordered.push({ time: r.time, text: r.text });
    }
  }
  for (const [time, entry] of byTime.entries()) {
    const idx = ordered.findIndex((l) => l.time === time);
    if (idx >= 0) ordered[idx].tr = entry.tr;
  }
  return ordered.sort((a, b) => a.time - b.time);
}

async function main() {
  console.log("A. Synced lines with `start` ms attribute — real timestamps, not 0:");
  {
    const xml = '<line start="1000">第一行</line><line start="4500">第二行</line>';
    const out = parseStructuredLines(xml);
    assert(out.length === 2, `2 lines parsed (got ${out.length})`);
    assert(out[0].time === 1, `first line time=1s (got ${out[0].time})`);
    assert(out[1].time === 4.5, `second line time=4.5s (got ${out[1].time})`);
    assert(out.some((l) => l.time > 0), "hasSynced-equivalent check (some l.time > 0) is true — this is exactly what was broken before");
  }

  console.log("\nB. Dual-language: consecutive same-timestamp lines group as original+translation:");
  {
    const xml = '<line start="1000">Hello</line><line start="1000">你好</line><line start="2000">World</line>';
    const out = parseStructuredLines(xml);
    assert(out.length === 2, `2 grouped entries (got ${out.length})`);
    assert(out[0].text === "Hello" && out[0].tr === "你好", `first entry has original+translation (got ${JSON.stringify(out[0])})`);
    assert(out[1].text === "World" && out[1].tr === undefined, `second entry has no translation (got ${JSON.stringify(out[1])})`);
  }

  console.log("\nC. Unsynced (synced=\"false\", no start attributes at all) — every line kept separate, time=0:");
  {
    const xml = "<line>Line one</line><line>Line two</line><line>Line three</line>";
    const out = parseStructuredLines(xml);
    assert(out.length === 3, `all 3 lines kept as separate entries (got ${out.length})`);
    assert(out.every((l) => l.time === 0), "every line time=0 (correctly unsynced, not incorrectly grouped as duplicates)");
  }

  console.log("\nD. Blank lines are skipped:");
  {
    const xml = '<line start="1000">Real line</line><line start="2000"></line><line start="3000">   </line>';
    const out = parseStructuredLines(xml);
    assert(out.length === 1, `blank-text lines dropped (got ${out.length})`);
  }

  console.log("\nE. XML entities decoded in line text:");
  {
    const xml = '<line start="1000">Tom &amp; Jerry</line>';
    const out = parseStructuredLines(xml);
    assert(out[0]?.text === "Tom & Jerry", `entity decoded (got "${out[0]?.text}")`);
  }

  console.log("\nF. Production source drift guard:");
  {
    const src = fs.readFileSync(path.resolve(__dirname, "../../web/src/views/NowPlaying.vue"), "utf-8");
    assert(src.includes("function parseStructuredLines"), "NowPlaying.vue still defines parseStructuredLines");
    assert(src.includes("parseStructuredLines(payload.structured)"), "the structuredLyrics branch calls parseStructuredLines, not the old text-only regex");
    assert(!/<line\[\^>\]\*>/.test(src) || src.includes("start=\"(\\d+)\")?"),
      "no longer relies on a start-attribute-blind <line> regex for the structured path");
    assert(src.includes("let lyricsRequest = 0;"), "lyrics requests have a generation counter");
    assert(src.includes("userScrolled.value = false;"), "track changes restore automatic lyric following");
    assert(src.includes("function resetLyricsScroll()"), "track changes reset the lyric scroll container");
    assert(src.includes("if (request !== lyricsRequest) return;"), "stale lyric responses cannot overwrite the current track");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
