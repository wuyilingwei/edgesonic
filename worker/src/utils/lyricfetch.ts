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
// Used by GET /rest/getLyrics and GET /rest/getLyricsBySongId as the fallback
// path when song_masters.lyrics is empty. We deliberately scope to NetEase
// only — it is the most stable of the four sources scrape.ts already proxies
// and it does not require signing / token negotiation. If the future shows we
// need QQ/Kugou as additional fallbacks, the SOURCE_CHAIN constant is the
// single drop-in extension point.
//
// All errors are swallowed: a missing lyric must not break /rest/getLyrics —
// the endpoint returns an empty <lyrics/> element on null. Each upstream
// timeout / non-2xx → next source → null.

const FETCH_TIMEOUT_MS = 6000;

// Real-browser UA to dodge NetEase's anti-bot heuristic. Same string as
// scrape.ts uses for parity.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Search → first hit → fetch lrc.lyric. Returns the LRC text or null.
async function fetchNetEaseLyric(artist: string, title: string): Promise<string | null> {
  try {
    // Step 1 — search. The web API returns { result: { songs: [{ id }, ...] } }.
    const query = `${title} ${artist}`.trim();
    if (!query) return null;
    const searchUrl = "https://music.163.com/api/search/get/web";
    const form = new URLSearchParams({ s: query, type: "1", offset: "0", limit: "5" });
    const searchResp = await timedFetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://music.163.com/",
        "User-Agent": UA,
      },
      body: form.toString(),
    });
    if (!searchResp.ok) return null;

    // The upstream payload is loose — guard every property access.
    const searchJson = (await searchResp.json()) as {
      result?: { songs?: Array<{ id?: number; name?: string; artists?: Array<{ name?: string }> }> };
    };
    const songs = searchJson.result?.songs;
    if (!songs || songs.length === 0) return null;

    // Pick the best match: case-insensitive title equality wins; otherwise
    // first hit. NetEase already ranks by relevance so this is usually safe.
    const norm = (s: string) => s.toLowerCase().trim();
    const pick =
      songs.find((s) => s.name && norm(s.name) === norm(title)) ?? songs[0];
    if (!pick?.id) return null;

    // Step 2 — lyric. The API returns { lrc: { lyric: "[00:00.00]..." } }
    // and may also return klyric / tlyric (karaoke / translation) which we
    // ignore for v1.
    const lyricUrl = `https://music.163.com/api/song/lyric?id=${pick.id}&lv=1&kv=1&tv=-1`;
    const lyricResp = await timedFetch(lyricUrl, {
      method: "GET",
      headers: { "Referer": "https://music.163.com/", "User-Agent": UA },
    });
    if (!lyricResp.ok) return null;
    const lyricJson = (await lyricResp.json()) as {
      lrc?: { lyric?: string };
    };
    const lrc = lyricJson.lrc?.lyric;
    if (!lrc || typeof lrc !== "string") return null;
    const trimmed = lrc.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Network error / abort / JSON parse failure — all swallowed.
    return null;
  }
}

// Public entry point. artist may be empty; title is required. Returns null
// when no source produced lyrics, or a non-empty string otherwise.
export async function fetchExternalLyric(
  artist: string | null | undefined,
  title: string | null | undefined,
): Promise<string | null> {
  const t = (title || "").trim();
  if (!t) return null;
  const a = (artist || "").trim();
  return fetchNetEaseLyric(a, t);
}
