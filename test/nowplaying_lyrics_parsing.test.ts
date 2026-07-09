// 114 — NowPlaying.vue's lyrics parsing/grouping helpers (isJunkLine,
// groupLyricLines, parseLrc).
//
// Coverage:
//   1. groupLyricLines folds a same-timestamp second entry into the first
//      line's `translation` (dual-track original+translation display).
//   2. groupLyricLines leaves distinct-timestamp lines as separate entries.
//   3. isJunkLine flags "{"-prefixed content (non-lyric JSON/metadata blob
//      some sources interleave) so it never gets rendered as a lyric line.
//   4. parseLrc: timestamps parsed to seconds, junk lines dropped, same-time
//      lines grouped into original+translation.
//   5. parseLrc: unsynced plain text still works (no "[mm:ss]" anywhere) and
//      still drops junk lines.
//
// NowPlaying.vue is a .vue SFC with these as un-exported <script setup>
// locals (can't import them directly — same constraint as
// task_executor_error_msg.test.ts's formatTaskError). We re-implement them
// here and guard against drift by checking the real file's source text.
//
// Run: npx tsx test/nowplaying_lyrics_parsing.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

interface LyricLine { time: number; text: string; translation?: string }

function isJunkLine(text: string): boolean {
  return text.trim().startsWith("{");
}

function groupLyricLines(raw: Array<{ time: number; text: string }>): LyricLine[] {
  const out: LyricLine[] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.time > 0 && Math.abs(last.time - r.time) < 0.001) {
      last.translation = last.translation ? `${last.translation}\n${r.text}` : r.text;
    } else {
      out.push({ time: r.time, text: r.text });
    }
  }
  return out;
}

function parseLrc(text: string): LyricLine[] {
  const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/g;
  const raw: Array<{ time: number; text: string }> = [];
  let m: RegExpExecArray | null;
  let hasTimestamps = false;
  while ((m = re.exec(text)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
    const line = m[4].trim();
    if (isJunkLine(line)) continue;
    hasTimestamps = true;
    raw.push({ time: min * 60 + sec + ms / 1000, text: line });
  }
  if (!hasTimestamps) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !isJunkLine(l)).map((text) => ({ time: 0, text }));
  }
  raw.sort((a, b) => a.time - b.time);
  return groupLyricLines(raw);
}

async function main() {
  console.log("groupLyricLines — same-timestamp pair becomes original+translation:");
  {
    const out = groupLyricLines([
      { time: 12.34, text: "Hello there" },
      { time: 12.34, text: "你好" },
      { time: 20, text: "Next line" },
    ]);
    assert(out.length === 2, `2 grouped lines (got ${out.length})`);
    assert(out[0].text === "Hello there" && out[0].translation === "你好", "line 1 text+translation paired");
    assert(out[1].text === "Next line" && out[1].translation === undefined, "line 2 has no translation");
  }

  console.log("\ngroupLyricLines — distinct timestamps stay separate, even when close:");
  {
    const out = groupLyricLines([{ time: 1, text: "a" }, { time: 1.5, text: "b" }]);
    assert(out.length === 2, "1.0s and 1.5s are distinct lines, not merged");
  }

  console.log("\ngroupLyricLines — time:0 (unsynced) entries never merge into translations:");
  {
    const out = groupLyricLines([{ time: 0, text: "a" }, { time: 0, text: "b" }]);
    assert(out.length === 2, "two unsynced (time=0) lines stay two separate lines, not folded as translation");
  }

  console.log("\nisJunkLine — flags \"{\"-prefixed content:");
  {
    assert(isJunkLine('{"t":0,"c":[]}') === true, "JSON blob flagged as junk");
    assert(isJunkLine("  {leading whitespace") === true, "leading whitespace trimmed before check");
    assert(isJunkLine("normal lyric line") === false, "normal text not flagged");
    assert(isJunkLine("[00:12.34]synced line") === false, "bracket-timestamp line not flagged as junk");
  }

  console.log("\nparseLrc — timestamps, junk-line drop, translation grouping:");
  {
    const out = parseLrc('[00:12.34]Hello there\n[00:12.34]你好\n{"junk":true}\n[00:20.00]Next line');
    assert(out.length === 2, `2 grouped lines after junk dropped (got ${out.length})`);
    assert(Math.abs(out[0].time - 12.34) < 0.001, `line 1 time ~12.34s (got ${out[0].time})`);
    assert(out[0].text === "Hello there" && out[0].translation === "你好", "line 1 original+translation");
    assert(Math.abs(out[1].time - 20) < 0.001 && out[1].text === "Next line", "line 2 correct");
  }

  console.log("\nparseLrc — unsynced plain text still drops junk lines:");
  {
    const out = parseLrc('just a line\n{"junk":true}\nanother line');
    assert(out.length === 2, `2 lines, junk dropped (got ${out.length})`);
    assert(out.every((l) => l.time === 0), "all unsynced (time=0)");
    assert(out[0].text === "just a line" && out[1].text === "another line", "content preserved in order");
  }

  console.log("\nsource drift guard:");
  {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../web/src/views/NowPlaying.vue"),
      "utf-8",
    );
    assert(src.includes("function isJunkLine(text: string): boolean"), "isJunkLine still present");
    assert(src.includes("function groupLyricLines(raw: Array<{ time: number; text: string }>): LyricLine[]"),
      "groupLyricLines still present");
    assert(/return text\.trim\(\)\.startsWith\("\{"\);/.test(src), "isJunkLine body unchanged");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("All assertions passed.");
}

main();
