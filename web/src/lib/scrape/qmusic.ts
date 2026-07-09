// QQ Music (Tencent) scrape adapter (task 040).
//
// API: c.y.qq.com/soso/fcgi-bin/client_search_cp (GET ?format=json)
//
// CORS: c.y.qq.com requires Referer = https://y.qq.com/. Browser can't set
// Referer, so direct fetch is doomed in production; we still try once for
// users behind CORS-relaxing proxies, then fall back to the Worker.

import type { ScrapeResult } from "./types";
import type { ProxyFn } from "./netease";

const SOURCE = "qmusic" as const;
const DIRECT_SEARCH = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const DIRECT_LYRIC = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const COVER_TPL = "https://y.qq.com/music/photo_new/T002R300x300M000{mid}.jpg";

interface QMusicSearchResp {
  data?: {
    song?: {
      list?: Array<{
        songmid?: string;
        songname?: string;
        singer?: Array<{ name?: string }>;
        albumname?: string;
        albummid?: string;
        pubtime?: number; // seconds
      }>;
    };
  };
}

interface QMusicLyricResp {
  lyric?: string;
  trans?: string;
}

export async function search(query: string, proxyFetch: ProxyFn): Promise<ScrapeResult[]> {
  const upstream = await tryDirectThenProxy<QMusicSearchResp>(
    "search",
    () => directSearch(query),
    () => proxyFetch({ source: SOURCE, intent: "search", query }),
  );
  return (upstream.data?.song?.list || []).map((s) => normalise(s));
}

export async function fetchLyric(songmid: string, proxyFetch: ProxyFn): Promise<string> {
  const upstream = await tryDirectThenProxy<QMusicLyricResp>(
    "lyric",
    () => directLyric(songmid),
    () => proxyFetch({ source: SOURCE, intent: "lyric", songId: songmid }),
  );
  // when proxied we always get raw LRC text. Direct path uses the same param.
  return upstream.lyric || "";
}

async function directSearch(query: string): Promise<QMusicSearchResp> {
  const url = `${DIRECT_SEARCH}?format=json&p=1&n=20&w=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function directLyric(songmid: string): Promise<QMusicLyricResp> {
  const url = `${DIRECT_LYRIC}?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function normalise(s: NonNullable<NonNullable<NonNullable<QMusicSearchResp["data"]>["song"]>["list"]>[number]): ScrapeResult {
  // pubtime is in seconds; 0 / missing → no year.
  const year =
    s.pubtime && s.pubtime > 0
      ? new Date(s.pubtime * 1000).getUTCFullYear()
      : undefined;
  return {
    source: SOURCE,
    songId: s.songmid || "",
    title: s.songname || "",
    artist: (s.singer || []).map((a) => a.name).filter(Boolean).join(", ") || "",
    album: s.albumname || undefined,
    year,
    coverUrl: s.albummid ? COVER_TPL.replace("{mid}", s.albummid) : undefined,
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
      throw new Error(`qmusic ${label}: ${(proxied?.error || (e as Error).message || "unknown")}`);
    }
    return proxied.data as T;
  }
}
