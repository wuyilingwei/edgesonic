// Shared types for the metadata scrape pipeline (task 040).
//
// Each provider in lib/scrape/{netease,qmusic,kugou}.ts normalises its
// upstream response into ScrapeResult[]; the aggregator (lib/scrape/index.ts)
// fans out to enabled sources in priority order and merges results.
//
// The Worker proxy (POST /rest/scrapeMetadata) is shape-agnostic and forwards
// the raw upstream JSON; normalisation happens client-side so each provider
// owns its own parsing rules and stays easy to debug in the browser console.

export type ScrapeSource = "netease" | "qmusic" | "kugou" | "kuwo" | "migu";

export interface ScrapeResult {
  /** Which provider this row came from. */
  source: ScrapeSource;
  /** Provider-specific upstream identifier (used to fetch lyric/detail later). */
  songId: string;
  /** Display fields — the parts users actually want to apply. */
  title: string;
  artist: string;
  album?: string;
  year?: number;
  /** Optional remote cover URL. 040 only carries it; 042 will download + write. */
  coverUrl?: string;
  /** Optional inline lyrics (already fetched). NetEase often inlines, others don't. */
  lyrics?: string;
  /** Original upstream payload — kept so caller can debug / submit verbatim. */
  raw?: unknown;
}

export interface ScrapeError {
  source: ScrapeSource;
  error: string;
}

export interface SearchResponse {
  /** Results in source-priority order — multiple sources concatenated. */
  results: ScrapeResult[];
  /** Per-source errors (one row per source that failed). */
  errors: ScrapeError[];
}
