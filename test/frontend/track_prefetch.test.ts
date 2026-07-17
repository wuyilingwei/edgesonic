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

// Contract and cache checks for next-track lyrics, metadata, and cover preloading.
// Run: npx tsx test/frontend/track_prefetch.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getTrackLyrics,
  getTrackMetadataXml,
  preloadTrack,
  type PrefetchTrack,
  type TrackPrefetchAuth,
} from "../../web/src/lib/trackPrefetch";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const track: PrefetchTrack = { id: "song-prefetch", title: "Next", artist: "Artist", coverArt: "al-cover" };

async function run() {
  const calls: string[] = [];
  const auth: TrackPrefetchAuth = {
    scope: "prefetch-cache-test",
    authFetch: async (pathName) => {
      calls.push(pathName);
      if (pathName === "getSong") return '<song id="song-prefetch" title="Next" />';
      if (pathName === "getLyricsBySongId") return '<structuredLyrics><line start="1000">Next line</line></structuredLyrics>';
      return "";
    },
    coverArtUrl: (id, size) => `/cover/${id}?size=${size}`,
  };

  const metadataA = await getTrackMetadataXml(track, auth);
  const metadataB = await getTrackMetadataXml(track, auth);
  assert(metadataA === metadataB, "metadata cache returns the same response");
  assert(calls.filter((name) => name === "getSong").length === 1, "metadata request is deduplicated");

  const lyricsA = await getTrackLyrics(track, auth);
  const lyricsB = await getTrackLyrics(track, auth);
  assert(lyricsA.structured?.includes("Next line") === true, "structured lyrics are cached");
  assert(lyricsA === lyricsB, "lyrics cache returns the same payload");
  assert(calls.filter((name) => name === "getLyricsBySongId").length === 1, "lyrics request is deduplicated");

  const coverUrls: string[] = [];
  const OriginalImage = globalThis.Image;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      coverUrls.push(value);
      queueMicrotask(() => this.onload?.());
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image;
  try {
    const preloadAuth: TrackPrefetchAuth = {
      ...auth,
      scope: "prefetch-entry-test",
      authFetch: auth.authFetch,
    };
    preloadTrack(track, preloadAuth);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.Image = OriginalImage;
  }
  assert(coverUrls.includes("/cover/al-cover?size=512"), "shared large cover is preloaded");
  assert(!coverUrls.includes("/cover/al-cover?size=96"), "duplicate small-cover preload is avoided");

  const playerSrc = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/player.ts"), "utf8");
  const nowPlayingSrc = fs.readFileSync(path.resolve(__dirname, "../../web/src/views/NowPlaying.vue"), "utf8");
  assert(playerSrc.includes("preloadTrack(nextTrack"), "next-track ancillary preload is wired up");
  // Metadata/lyrics/covers are small: they must fire on the timing gate alone.
  // Sitting behind the current track's full-file fetch means a slow or failed
  // fetch silently cancels every prefetch.
  const ancillaryAt = playerSrc.indexOf("prefetchNextTrackData();");
  const audioGateAt = playerSrc.indexOf("if (isFullyBuffered(el, dur)) preloadNext();");
  assert(
    ancillaryAt >= 0 && audioGateAt >= 0 && ancillaryAt < audioGateAt,
    "ancillary prefetch is not gated on the current track being fully buffered",
  );
  assert(nowPlayingSrc.includes("getTrackLyrics(trackAtChange"), "detail lyrics reuse the preload cache");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
