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

// LRU fallback + weighted (freq + recency + size/duration efficiency) eviction
// core + no-IndexedDB degradation for the manual audio cache.
// Run: npx tsx test/frontend/audio_cache.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function run() {
  const { planLruEviction, planWeightedEviction, getCachedTrack, putCachedTrack, clearAudioCache, audioCacheStats } =
    await import("../../web/src/lib/audioCache");

  const MB = 1024 * 1024;
  const entry = (id: string, size: number, lastUsedAt: number, playCount = 0, duration = 0) =>
    ({ id, size, lastUsedAt, playCount, duration });

  // -- planLruEviction (fallback) ------------------------------------------
  assert(planLruEviction([], 100).length === 0, "LRU: empty cache evicts nothing");
  assert(
    planLruEviction([entry("a", 10 * MB, 1, 0), entry("b", 20 * MB, 2, 0)], 100 * MB).length === 0,
    "LRU: under the cap evicts nothing",
  );
  const over = [entry("oldest", 40 * MB, 1), entry("middle", 40 * MB, 2), entry("newest", 40 * MB, 3)];
  assert(
    JSON.stringify(planLruEviction(over, 100 * MB)) === JSON.stringify(["oldest"]),
    "LRU: over cap evicts only as many oldest entries as needed",
  );
  assert(
    JSON.stringify(planLruEviction(over, 0)) === JSON.stringify(["oldest", "middle", "newest"]),
    "LRU: zero cap evicts everything, oldest first",
  );

  // -- planWeightedEviction -------------------------------------------------
  assert(planWeightedEviction([], 100).length === 0, "weighted: empty cache evicts nothing");
  assert(
    planWeightedEviction([entry("a", 10 * MB, 1, 1, 60), entry("b", 20 * MB, 2, 1, 60)], 100 * MB).length === 0,
    "weighted: under the cap evicts nothing",
  );

  // Tied freq + recency + efficiency => still must drop enough to fit.
  const tie = [
    entry("x", 40 * MB, 5, 3, 60),
    entry("y", 40 * MB, 5, 3, 60),
    entry("z", 40 * MB, 5, 3, 60),
  ];
  assert(planWeightedEviction(tie, 100 * MB).length === 1, "weighted: tied scores still evict enough to fit");

  // Frequency dominates (W_FREQ=0.5): a rarely-played recent track is dropped
  // before a frequently-played stale one.
  const freqWins = [
    entry("rare", 40 * MB, 100, 1, 60),
    entry("stale-fav", 40 * MB, 1, 50, 60),
  ];
  assert(
    JSON.stringify(planWeightedEviction(freqWins, 50 * MB)) === JSON.stringify(["rare"]),
    "weighted: frequently-played track survives over a rarely-played recent one",
  );

  // Efficiency: with freq and recency equal, the bulky high-bitrate track
  // (large bytes per second) is evicted before the space-efficient one.
  const effWins = [
    entry("flac-bulky", 40 * MB, 5, 3, 60),   // ~0.67 MB/s
    entry("mp3-lean", 40 * MB, 5, 3, 300),    // ~0.13 MB/s — same size, far longer
  ];
  assert(
    JSON.stringify(planWeightedEviction(effWins, 50 * MB)) === JSON.stringify(["flac-bulky"]),
    "weighted: high-bitrate (size/duration) track is evicted over a space-efficient one",
  );

  // Efficiency needs at least two known durations to produce a signal;
  // until then every entry is neutral. With two known + one unknown, the
  // unknown's neutral 0.5 sits between the most- and least-efficient, so the
  // bulky high-bitrate known entry is evicted first, the unknown next.
  const mixedDur = [
    entry("unknown", 40 * MB, 5, 3, 0),       // neutral 0.5
    entry("lean", 40 * MB, 5, 3, 300),        // low bitrate → efficiency 1
    entry("bulky", 40 * MB, 5, 3, 60),        // high bitrate → efficiency 0
  ];
  // total 120MB. Under a 90MB cap we need to drop one entry (→80); the bulky
  // high-bitrate one is the lowest score and goes first.
  assert(
    JSON.stringify(planWeightedEviction(mixedDur, 90 * MB)) === JSON.stringify(["bulky"]),
    "weighted: with >=2 known durations, the bulky track is evicted before the neutral unknown",
  );
  // Under a 40MB cap we must drop two entries; bulky first, then the neutral
  // unknown, keeping the space-efficient lean one.
  assert(
    JSON.stringify(planWeightedEviction(mixedDur, 40 * MB)) === JSON.stringify(["bulky", "unknown"]),
    "weighted: under tighter cap the neutral-unknown is evicted next, lean is kept",
  );
  // Only one known duration present => efficiency carries no signal; freq and
  // recency (both tied) decide, so the outcome is a stable tie-break and the
  // single known entry is not penalised for being the only sample.
  const singleKnown = [
    entry("unknown", 40 * MB, 5, 3, 0),
    entry("only-known", 40 * MB, 5, 3, 60),
  ];
  assert(
    planWeightedEviction(singleKnown, 50 * MB).length === 1,
    "weighted: fewer than two known durations keeps efficiency neutral",
  );

  // Zero cap => evict everything, lowest score first.
  const mixed = [
    entry("lo", 40 * MB, 1, 0, 60),
    entry("mid", 40 * MB, 50, 5, 60),
    entry("hi", 40 * MB, 100, 50, 60),
  ];
  const zeroCap = planWeightedEviction(mixed, 0);
  assert(zeroCap.length === 3, "weighted: zero cap evicts everything");
  assert(zeroCap[0] === "lo", "weighted: lowest-score entry evicted first");

  // Single oversized entry is evicted.
  assert(
    planWeightedEviction([entry("huge", 300 * MB, 5, 5, 60)], 100 * MB).length === 1,
    "weighted: a single oversized entry is evicted",
  );

  // -- Degradation without IndexedDB (node has none) -------------------------
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  const got = await getCachedTrack("any");
  assert(got === null, "getCachedTrack resolves null without IndexedDB");
  await putCachedTrack("any", new Blob(["x"]), 60);
  assert(true, "putCachedTrack no-ops without IndexedDB");
  assert((await audioCacheStats()) === null, "audioCacheStats resolves null without IndexedDB");
  assert((await clearAudioCache()) === false, "clearAudioCache resolves false without IndexedDB");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });