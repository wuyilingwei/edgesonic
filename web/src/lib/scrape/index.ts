// Metadata scrape aggregator (task 040).
//
// Drives the per-source adapters (netease/qmusic/kugou) according to the
// Settings-managed priority list. Each source falls back to the Worker proxy
// when direct CORS fails (see netease.ts:tryDirectThenProxy).
//
// Public surface (used by ScrapeButton.vue):
//   - searchAll({ query, sources, proxyFetch }) → SearchResponse
//   - fetchLyric({ source, songId, proxyFetch })
//   - submitResult({ result, songMasterId?, mode? }, authPost) → audit row id
//
// `proxyFetch` is injected by the caller (api.ts useAuth().authPost wrapped
// to POST /rest/scrapeMetadata). This keeps the adapters dependency-light:
// they don't import api.ts directly, which makes them testable + portable.

import * as netease from "./netease";
import * as qmusic from "./qmusic";
import * as kugou from "./kugou";
import type {
  ScrapeResult,
  ScrapeSource,
  SearchResponse,
} from "./types";
import type { ProxyFn } from "./netease";

export type { ScrapeResult, ScrapeSource, SearchResponse } from "./types";
export type { ProxyFn } from "./netease";

const ADAPTERS: Record<ScrapeSource, {
  search: (q: string, p: ProxyFn) => Promise<ScrapeResult[]>;
  fetchLyric: (id: string, p: ProxyFn) => Promise<string>;
} | undefined> = {
  netease: { search: netease.search, fetchLyric: netease.fetchLyric },
  qmusic: { search: qmusic.search, fetchLyric: qmusic.fetchLyric },
  kugou: { search: kugou.search, fetchLyric: kugou.fetchLyric },
  // 040 doesn't ship kuwo/migu adapters; the keys exist in types so the
  // Settings UI can still validate user input. Aggregator silently skips them.
  kuwo: undefined,
  migu: undefined,
};

interface SearchOpts {
  query: string;
  sources: ScrapeSource[];
  proxyFetch: ProxyFn;
  /** Per-source limit (we keep ≤ 20 by upstream API design). */
  perSourceLimit?: number;
}

/** Fan-out search to every enabled source; concatenate in priority order. */
export async function searchAll(opts: SearchOpts): Promise<SearchResponse> {
  const limit = opts.perSourceLimit ?? 10;
  const results: ScrapeResult[] = [];
  const errors: Array<{ source: ScrapeSource; error: string }> = [];

  // Sequential to honor priority order in the output list; the typical query
  // returns within ~2s per source, and users only ever scrape one song at a
  // time — parallelism here would just complicate ordering.
  for (const src of opts.sources) {
    const ad = ADAPTERS[src];
    if (!ad) continue;
    try {
      const rows = await ad.search(opts.query, opts.proxyFetch);
      results.push(...rows.slice(0, limit));
    } catch (e) {
      errors.push({ source: src, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, errors };
}

interface LyricOpts {
  source: ScrapeSource;
  songId: string;
  proxyFetch: ProxyFn;
}

export async function fetchLyric(opts: LyricOpts): Promise<string> {
  const ad = ADAPTERS[opts.source];
  if (!ad) throw new Error(`scrape source ${opts.source} not supported`);
  return ad.fetchLyric(opts.songId, opts.proxyFetch);
}

// ===========================================================================
// Submit + history helpers — thin wrappers around the W endpoints.
// Callers pass their authenticated POST/GET functions in to avoid coupling
// the adapters to api.ts.
// ===========================================================================
export interface SubmitOpts {
  songMasterId?: string;
  source: ScrapeSource;
  songId?: string;
  query?: string;
  result: ScrapeResult;
  mode?: "tags" | "cover" | "both";
}

export async function submitResult(
  opts: SubmitOpts,
  authPost: (path: string, body: unknown) => Promise<string>,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  return JSON.parse(await authPost("submitScrapeResult", {
    songMasterId: opts.songMasterId,
    source: opts.source,
    songId: opts.songId,
    query: opts.query,
    result: opts.result,
    mode: opts.mode || "tags",
  }));
}

export async function getHistory(
  params: { limit?: number; offset?: number; songMasterId?: string },
  authFetch: (path: string, q?: Record<string, string>) => Promise<string>,
): Promise<unknown> {
  const q: Record<string, string> = {};
  if (params.limit != null) q.limit = String(params.limit);
  if (params.offset != null) q.offset = String(params.offset);
  if (params.songMasterId) q.songMasterId = params.songMasterId;
  return JSON.parse(await authFetch("getScrapeHistory", q));
}

/**
 * Build a `ProxyFn` from an authenticated POST function. ScrapeButton.vue
 * wires this up by passing `useAuth().authPost`.
 */
export function makeProxyFetch(
  authPost: (path: string, body: unknown) => Promise<string>,
): ProxyFn {
  return async (req) => JSON.parse(await authPost("scrapeMetadata", req));
}
