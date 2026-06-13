// Kugou scrape adapter (task 040).
//
// API: songsearch.kugou.com/song_search_v2 (the v2 endpoint is the easiest
// public one — no signature param required).
//
// CORS: all kugou domains refuse CORS in production. Direct fetch is almost
// guaranteed to fail; we still try once for completeness, then fall back to
// the Worker proxy.

import type { ScrapeResult } from "./types";
import type { ProxyFn } from "./netease";

const SOURCE = "kugou" as const;
const DIRECT_SEARCH = "https://songsearch.kugou.com/song_search_v2";

interface KugouSearchResp {
  data?: {
    lists?: Array<{
      FileHash?: string;
      SongName?: string;
      SingerName?: string;
      AlbumName?: string;
    }>;
  };
}

interface KugouLyricResp {
  fmt?: string;
  content?: string; // base64 LRC
}

export async function search(query: string, proxyFetch: ProxyFn): Promise<ScrapeResult[]> {
  const upstream = await tryDirectThenProxy<KugouSearchResp>(
    "search",
    () => directSearch(query),
    () => proxyFetch({ source: SOURCE, intent: "search", query }),
  );
  return (upstream.data?.lists || []).map((s) => normalise(s));
}

export async function fetchLyric(fileHash: string, proxyFetch: ProxyFn): Promise<string> {
  // Direct path is hopeless for Kugou (two CORS-blocked hops). Just proxy.
  const upstream = (await proxyFetch({
    source: SOURCE,
    intent: "lyric",
    songId: fileHash,
  })) as { ok: boolean; data?: KugouLyricResp; error?: string };
  if (!upstream?.ok) throw new Error(`kugou lyric: ${upstream?.error || "unknown"}`);
  const content = upstream.data?.content;
  if (!content) return "";
  // Kugou returns base64 LRC; decode in the browser.
  try { return atob(content); } catch { return content; }
}

async function directSearch(query: string): Promise<KugouSearchResp> {
  const url = `${DIRECT_SEARCH}?keyword=${encodeURIComponent(query)}&page=1&pagesize=20`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function normalise(s: NonNullable<NonNullable<KugouSearchResp["data"]>["lists"]>[number]): ScrapeResult {
  return {
    source: SOURCE,
    songId: s.FileHash || "",
    title: s.SongName || "",
    artist: s.SingerName || "",
    album: s.AlbumName || undefined,
    raw: s,
  };
}

async function tryDirectThenProxy<T>(
  label: string,
  direct: () => Promise<T>,
  viaProxy: () => Promise<unknown>,
): Promise<T> {
  try {
    return await direct();
  } catch (e) {
    const proxied = (await viaProxy()) as { ok: boolean; data?: T; error?: string };
    if (!proxied?.ok) {
      throw new Error(`kugou ${label}: ${(proxied?.error || (e as Error).message || "unknown")}`);
    }
    return proxied.data as T;
  }
}
