// NetEase Music scrape adapter (task 040).
//
// API docs: https://music.163.com/api/search/get/web (POST form-urlencoded)
//
// CORS reality check: music.163.com refuses cross-origin browser fetches
// (Referer + CORS). We try direct first (in case a user mirrors the site or
// runs behind a CORS-relaxing proxy), then fall back to /rest/scrapeMetadata
// which routes through the Worker.
//
// Both paths return the same upstream JSON shape; only the transport differs.

import type { ScrapeResult } from "./types";

const SOURCE = "netease" as const;
const DIRECT_SEARCH = "https://music.163.com/api/search/get/web";
const DIRECT_LYRIC = "https://music.163.com/api/song/lyric";

interface NetEaseSearchResp {
  result?: {
    songs?: Array<{
      id: number;
      name: string;
      artists?: Array<{ name?: string }>;
      album?: { name?: string; picUrl?: string; publishTime?: number };
    }>;
  };
}

interface NetEaseLyricResp {
  lrc?: { lyric?: string };
}

/** Search NetEase by free-text query. Tries direct → proxy. */
export async function search(query: string, proxyFetch: ProxyFn): Promise<ScrapeResult[]> {
  const upstream = await tryDirectThenProxy<NetEaseSearchResp>(
    "search",
    () => directSearch(query),
    () => proxyFetch({ source: SOURCE, intent: "search", query }),
  );
  return (upstream.result?.songs || []).map((s) => normalise(s));
}

/** Fetch inline lyrics by songId. NetEase returns LRC text. */
export async function fetchLyric(songId: string, proxyFetch: ProxyFn): Promise<string> {
  const upstream = await tryDirectThenProxy<NetEaseLyricResp>(
    "lyric",
    () => directLyric(songId),
    () => proxyFetch({ source: SOURCE, intent: "lyric", songId }),
  );
  return upstream.lrc?.lyric || "";
}

// ===========================================================================
// Direct (browser) fetches — likely to fail CORS, but cheap to try.
// ===========================================================================
async function directSearch(query: string): Promise<NetEaseSearchResp> {
  const form = new URLSearchParams({ s: query, type: "1", offset: "0", limit: "20" });
  const resp = await fetch(DIRECT_SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function directLyric(songId: string): Promise<NetEaseLyricResp> {
  const url = `${DIRECT_LYRIC}?id=${encodeURIComponent(songId)}&lv=1&kv=1&tv=-1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ===========================================================================
// Normaliser — turns upstream payload into ScrapeResult.
// ===========================================================================
function normalise(s: NonNullable<NonNullable<NetEaseSearchResp["result"]>["songs"]>[number]): ScrapeResult {
  const year =
    s.album?.publishTime && s.album.publishTime > 0
      ? new Date(s.album.publishTime).getUTCFullYear()
      : undefined;
  return {
    source: SOURCE,
    songId: String(s.id),
    title: s.name || "",
    artist: (s.artists || []).map((a) => a.name).filter(Boolean).join(", ") || "",
    album: s.album?.name || undefined,
    year,
    coverUrl: s.album?.picUrl || undefined,
    raw: s,
  };
}

// ===========================================================================
// Direct→proxy fallback shared with sibling adapters
// ===========================================================================
export type ProxyFn = (req: {
  source: typeof SOURCE | "qmusic" | "kugou" | "kuwo" | "migu";
  intent: "search" | "lyric" | "detail";
  query?: string;
  songId?: string;
}) => Promise<unknown>;

async function tryDirectThenProxy<T>(
  label: string,
  direct: () => Promise<T>,
  viaProxy: () => Promise<unknown>,
): Promise<T> {
  try {
    return await direct();
  } catch (e) {
    // Direct path failed (CORS, network, 4xx) — fall back to Worker proxy.
    // The proxy returns { ok: true, data: <upstream> }, see worker scrape.ts.
    const proxied = (await viaProxy()) as { ok: boolean; data?: T; error?: string };
    if (!proxied?.ok) {
      throw new Error(`netease ${label}: ${(proxied?.error || (e as Error).message || "unknown")}`);
    }
    return proxied.data as T;
  }
}
