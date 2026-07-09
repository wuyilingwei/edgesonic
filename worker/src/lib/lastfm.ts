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

// ============================================================================
//
// All read-only endpoints (no user session, only server api_key). KV-fronted
// with a 24h TTL — last.fm's "what's hot" data barely shifts that often, and
// we'd rather eat occasional staleness than burn through the ~5 req/s/key
// soft limit when DSub fires off getArtistInfo + getSimilarSongs back-to-back.
//
// API key lives in `feature_strings.lastfm_api_key`. Empty value → throw
// LastfmUnconfigured, which the Subsonic endpoints translate into error
// code 30 ("not supported") so the rest of the API stays available.
// ============================================================================

import { getFeatureString } from "../utils/features";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";
const CACHE_TTL_SEC = 24 * 60 * 60; // 24h
const FETCH_TIMEOUT_MS = 8000;

// Thrown when feature_strings.lastfm_api_key is empty or missing.
// Endpoints catch this and respond with Subsonic error code 30.
export class LastfmUnconfigured extends Error {
  constructor() {
    super("Last.fm API key not configured");
    this.name = "LastfmUnconfigured";
  }
}

// Thrown when the upstream returns a non-2xx HTTP response, or a Last.fm
// "error" payload (e.g. `{ error: 6, message: "The artist you supplied could
// not be found" }`).
export class LastfmFetchError extends Error {
  upstreamCode?: number;
  constructor(msg: string, upstreamCode?: number) {
    super(msg);
    this.name = "LastfmFetchError";
    this.upstreamCode = upstreamCode;
  }
}

// Normalise parameter ordering so cache keys hash stably regardless of the
// order callers pass keys in.
function stableParamString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

// Core fetch primitive. Reads api_key from user_settings (per-user) first,
// falls back to feature_strings.lastfm_api_key (system-level). Hits D1
// lastfm_cache first, then reaches out to ws.audioscrobbler.com on a miss.
export async function lastfmFetch(
  env: Env,
  method: string,
  params: Record<string, string | number | undefined>,
  username?: string,
): Promise<Record<string, unknown>> {
  let apiKey = "";
  if (username) {
    const userRow = await env.DB.prepare(
      "SELECT value FROM user_settings WHERE username = ? AND key = 'lastfm_api_key'"
    ).bind(username).first<{ value: string }>();
    if (userRow?.value) apiKey = userRow.value.trim();
  }
  if (!apiKey) {
    apiKey = (await getFeatureString(env, "lastfm_api_key", "")).trim();
  }
  if (!apiKey) throw new LastfmUnconfigured();

  // Cache key omits the api_key itself; rotating the key shouldn't invalidate
  // the dataset because the dataset hasn't changed.
  const cacheKey = `lastfm:${method}:${stableParamString(params)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cacheRow = await env.DB.prepare(
    "SELECT value FROM lastfm_cache WHERE cache_key = ? AND expires_at > ?"
  ).bind(cacheKey, nowSec).first<{ value: string }>();
  if (cacheRow !== null) {
    try { return JSON.parse(cacheRow.value) as Record<string, unknown>; }
    catch { /* corrupt cache → fall through and re-fetch */ }
  }

  const url = new URL(BASE_URL);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": "EdgeSonic/1.0" },
      signal: controller.signal,
    });
  } catch (e) {
    throw new LastfmFetchError(
      e instanceof Error ? `Last.fm fetch failed: ${e.message}` : "Last.fm fetch failed",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new LastfmFetchError(`Last.fm HTTP ${res.status}`);
  }
  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch (e) {
    throw new LastfmFetchError("Last.fm returned non-JSON");
  }
  // Last.fm signals errors with { error: <code>, message: "..." } at the top.
  if (typeof body.error === "number") {
    throw new LastfmFetchError(
      typeof body.message === "string" ? body.message : "Last.fm error",
      body.error,
    );
  }

  await env.DB.prepare(
    "INSERT INTO lastfm_cache (cache_key, value, expires_at) VALUES (?, ?, ?)" +
    " ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
  ).bind(cacheKey, JSON.stringify(body), nowSec + CACHE_TTL_SEC).run();
  return body;
}

// ---------------------------------------------------------------------------
// Typed wrappers — each returns a flattened, "useful" shape so endpoints
// don't have to re-implement bio cleanup / image picking.
// ---------------------------------------------------------------------------

export interface LastfmImage {
  small?: string;
  medium?: string;
  large?: string;
}

function pickImages(arr: unknown): LastfmImage {
  if (!Array.isArray(arr)) return {};
  const out: LastfmImage = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const size = (entry as Record<string, unknown>).size;
    const text = (entry as Record<string, unknown>)["#text"];
    if (typeof size !== "string" || typeof text !== "string" || !text) continue;
    if (size === "small") out.small = text;
    else if (size === "medium") out.medium = text;
    else if (size === "large" || size === "extralarge" || size === "mega") {
      // Subsonic only has one "large" slot — last larger wins.
      out.large = text;
    }
  }
  return out;
}

// Strip the "<a href="...">Read more on Last.fm</a>" trailer (and similar
// inline anchors) from the bio summary. Other HTML tags are rare and left
// alone so clients can render them if they want.
export function stripLastfmAnchors(text: string): string {
  return text.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "").trim();
}

export interface LastfmArtistInfo {
  name: string;
  mbid?: string;
  url?: string;
  biography: string;
  images: LastfmImage;
}

export async function getArtistInfo(env: Env, name: string, username?: string): Promise<LastfmArtistInfo | null> {
  const data = await lastfmFetch(env, "artist.getInfo", { artist: name, autocorrect: 1 }, username);
  const artist = data.artist as Record<string, unknown> | undefined;
  if (!artist) return null;
  const bio = (artist.bio as Record<string, unknown> | undefined) ?? {};
  const summary = typeof bio.summary === "string" ? bio.summary : "";
  const content = typeof bio.content === "string" ? bio.content : "";
  const cleaned = stripLastfmAnchors(content || summary);
  return {
    name: typeof artist.name === "string" ? artist.name : name,
    mbid: typeof artist.mbid === "string" && artist.mbid ? artist.mbid : undefined,
    url: typeof artist.url === "string" ? artist.url : undefined,
    biography: cleaned,
    images: pickImages(artist.image),
  };
}

export interface LastfmAlbumInfo {
  name: string;
  artist: string;
  mbid?: string;
  url?: string;
  notes: string;
  images: LastfmImage;
}

export async function getAlbumInfo(env: Env, artist: string, album: string, username?: string): Promise<LastfmAlbumInfo | null> {
  const data = await lastfmFetch(env, "album.getInfo", { artist, album, autocorrect: 1 }, username);
  const al = data.album as Record<string, unknown> | undefined;
  if (!al) return null;
  const wiki = (al.wiki as Record<string, unknown> | undefined) ?? {};
  const summary = typeof wiki.summary === "string" ? wiki.summary : "";
  const content = typeof wiki.content === "string" ? wiki.content : "";
  return {
    name: typeof al.name === "string" ? al.name : album,
    artist: typeof al.artist === "string" ? al.artist : artist,
    mbid: typeof al.mbid === "string" && al.mbid ? al.mbid : undefined,
    url: typeof al.url === "string" ? al.url : undefined,
    notes: stripLastfmAnchors(content || summary),
    images: pickImages(al.image),
  };
}

export interface LastfmSimilarArtist {
  name: string;
  mbid?: string;
  url?: string;
  images: LastfmImage;
}

export async function getSimilarArtists(
  env: Env,
  name: string,
  limit: number,
  username?: string,
): Promise<LastfmSimilarArtist[]> {
  const data = await lastfmFetch(env, "artist.getSimilar", {
    artist: name, limit, autocorrect: 1,
  }, username);
  const wrap = data.similarartists as Record<string, unknown> | undefined;
  const arr = wrap?.artist;
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => {
    const obj = a as Record<string, unknown>;
    return {
      name: typeof obj.name === "string" ? obj.name : "",
      mbid: typeof obj.mbid === "string" && obj.mbid ? obj.mbid : undefined,
      url: typeof obj.url === "string" ? obj.url : undefined,
      images: pickImages(obj.image),
    };
  }).filter((a) => a.name);
}

export interface LastfmSimilarTrack {
  name: string;
  artist: string;
  mbid?: string;
  url?: string;
  duration?: number;
}

export async function getSimilarTracks(
  env: Env,
  artist: string,
  track: string,
  limit: number,
  username?: string,
): Promise<LastfmSimilarTrack[]> {
  const data = await lastfmFetch(env, "track.getSimilar", {
    artist, track, limit, autocorrect: 1,
  }, username);
  const wrap = data.similartracks as Record<string, unknown> | undefined;
  const arr = wrap?.track;
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => {
    const obj = t as Record<string, unknown>;
    const artistObj = obj.artist as Record<string, unknown> | undefined;
    return {
      name: typeof obj.name === "string" ? obj.name : "",
      artist: typeof artistObj?.name === "string" ? artistObj.name : "",
      mbid: typeof obj.mbid === "string" && obj.mbid ? obj.mbid : undefined,
      url: typeof obj.url === "string" ? obj.url : undefined,
      duration: typeof obj.duration === "string" ? parseInt(obj.duration, 10) || undefined : undefined,
    };
  }).filter((t) => t.name);
}

export interface LastfmTopTrack {
  name: string;
  artist: string;
  mbid?: string;
  url?: string;
  playcount?: number;
  listeners?: number;
}

export async function getTopTracks(
  env: Env,
  artist: string,
  limit: number,
  username?: string,
): Promise<LastfmTopTrack[]> {
  const data = await lastfmFetch(env, "artist.getTopTracks", {
    artist, limit, autocorrect: 1,
  }, username);
  const wrap = data.toptracks as Record<string, unknown> | undefined;
  const arr = wrap?.track;
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => {
    const obj = t as Record<string, unknown>;
    const artistObj = obj.artist as Record<string, unknown> | undefined;
    return {
      name: typeof obj.name === "string" ? obj.name : "",
      artist: typeof artistObj?.name === "string" ? artistObj.name : artist,
      mbid: typeof obj.mbid === "string" && obj.mbid ? obj.mbid : undefined,
      url: typeof obj.url === "string" ? obj.url : undefined,
      playcount: typeof obj.playcount === "string" ? parseInt(obj.playcount, 10) || undefined : undefined,
      listeners: typeof obj.listeners === "string" ? parseInt(obj.listeners, 10) || undefined : undefined,
    };
  }).filter((t) => t.name);
}
