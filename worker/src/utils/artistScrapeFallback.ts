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

// Artist bio/cover resolution across all configured sources — netease, qmusic,
// and last.fm — tried in the admin-configured priority order (260). Last.fm
// is no longer hardcoded as the first thing tried: it is just another member
// of the same ordered, individually-toggleable list as the CN sources, and
// defaults to LAST so CN coverage (much better for CN artists) is tried
// first. Callers that only need "missing fields for this artist" pass
// `want: { bio, cover }`; resolveArtistInfo stops as soon as both are filled.
//
// "High confidence only" rule for CN sources: we only accept a scrape result
// when the upstream artist name matches the queried name (case-insensitive,
// after trimming whitespace and stripping common suffixes like "（歌手）").
// This prevents writing a wrong bio when the scrape search returns a
// similarly-named but different artist. Last.fm's artist.getInfo has no such
// ambiguity (autocorrect + exact param match), so no confidence check there.
//
// All functions return null/undefined fields on failure so callers can treat
// resolution as best-effort.
import { getFeatureString } from "./features";
import { getArtistInfo as lastfmGetArtistInfo } from "../lib/lastfm";
import {
  searchNetEaseArtist,
  fetchNetEaseArtistBio,
  fetchNetEaseArtistCover,
  searchQMusicArtist,
  fetchQMusicArtistBio,
  fetchQMusicArtistCover,
} from "../endpoints/edgesonic/artistScrape";

export type ArtistInfoSource = "netease" | "qmusic" | "lastfm";
const ALL_ARTIST_INFO_SOURCES: readonly ArtistInfoSource[] = ["netease", "qmusic", "lastfm"];

export interface ArtistScrapeFallback {
  biography?: string;
  largeImageUrl?: string;
  source: ArtistInfoSource;
  // Last.fm-only supplementary fields — CN sources never populate these.
  mbid?: string;
  lastfmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
}

// Normalise an artist name for confidence matching. Lowercases, trims, and
// strips parenthetical suffixes like "（歌手）" / "(singer)" that NetEase
// appends to disambiguate same-name artists.
function normaliseName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]\s*$/, "")
    .trim();
}

async function tryNetEase(name: string, wantBio: boolean, wantCover: boolean): Promise<ArtistScrapeFallback | null> {
  try {
    const results = await searchNetEaseArtist(name);
    if (results.length === 0) return null;
    // High confidence: first result whose normalised name matches.
    const target = normaliseName(name);
    const hit = results.find((r) => normaliseName(r.name) === target) ?? null;
    if (!hit) return null;
    const out: ArtistScrapeFallback = { source: "netease" };
    if (wantCover && hit.picUrl) out.largeImageUrl = hit.picUrl;
    if (wantBio) {
      try { out.biography = await fetchNetEaseArtistBio(String(hit.id)); }
      catch { /* bio optional */ }
    }
    if (!out.biography && !out.largeImageUrl) return null;
    return out;
  } catch {
    return null;
  }
}

async function tryQMusic(name: string, wantBio: boolean, wantCover: boolean): Promise<ArtistScrapeFallback | null> {
  try {
    const results = await searchQMusicArtist(name);
    if (results.length === 0) return null;
    const target = normaliseName(name);
    const hit = results.find((r) => normaliseName(r.name) === target) ?? null;
    if (!hit) return null;
    const out: ArtistScrapeFallback = { source: "qmusic" };
    if (wantCover && hit.cover) out.largeImageUrl = hit.cover;
    if (wantBio) {
      try { out.biography = await fetchQMusicArtistBio(hit.id); }
      catch { /* bio optional */ }
    }
    if (!out.biography && !out.largeImageUrl) return null;
    return out;
  } catch {
    return null;
  }
}

async function tryLastfm(env: Env, name: string): Promise<ArtistScrapeFallback | null> {
  const info = await lastfmGetArtistInfo(env, name).catch(() => null);
  if (!info) return null;
  const out: ArtistScrapeFallback = {
    source: "lastfm",
    biography: info.biography || undefined,
    largeImageUrl: info.images.large,
    mbid: info.mbid,
    lastfmUrl: info.url,
    smallImageUrl: info.images.small,
    mediumImageUrl: info.images.medium,
  };
  if (!out.biography && !out.largeImageUrl) return null;
  return out;
}

// Reads `lastfm_fallback_sources` (JSON array of source ids) and returns the
// enabled subset in stored order. A source not present in the array is
// treated as disabled — this is the same self-healing rule the
// scrape_enabled_sources UI already uses, so a pre-260 deployment whose
// stored value is `["netease","qmusic"]` (no "lastfm") keeps last.fm off
// until an admin explicitly re-adds it, instead of silently changing
// behavior on deploy.
export async function resolveArtistInfoSourceOrder(env: Env): Promise<ArtistInfoSource[]> {
  const raw = await getFeatureString(env, "lastfm_fallback_sources", '["netease","qmusic","lastfm"]');
  let stored: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) stored = parsed.filter((s) => typeof s === "string");
  } catch { /* malformed → nothing enabled */ }
  return stored.filter((s): s is ArtistInfoSource =>
    (ALL_ARTIST_INFO_SOURCES as readonly string[]).includes(s));
}

// Public entry point. Tries each enabled source in the configured priority
// order, stopping as soon as both wanted fields are filled. `want` controls
// which fields the caller needs — if only a biography is missing, cover
// fetches are skipped (and vice versa).
export async function resolveArtistInfo(
  env: Env,
  name: string,
  want: { bio: boolean; cover: boolean },
): Promise<ArtistScrapeFallback | null> {
  if (!want.bio && !want.cover) return null;
  const order = await resolveArtistInfoSourceOrder(env);
  if (order.length === 0) return null;

  for (const src of order) {
    let result: ArtistScrapeFallback | null = null;
    if (src === "netease") result = await tryNetEase(name, want.bio, want.cover);
    else if (src === "qmusic") result = await tryQMusic(name, want.bio, want.cover);
    else if (src === "lastfm") result = await tryLastfm(env, name);
    if (result) return result;
  }
  return null;
}
