// ============================================================================
// ----------------------------------------------------------------------------
//   refreshChannel(db, channelId)   — fetch RSS, update channel meta + episodes
//   refreshAllChannels(db)          — invoked by the hourly Cron Trigger
//   downloadEpisodeToR2(...)        — fired from ctx.waitUntil for one episode
//
// All three swallow errors into the appropriate `status` + `error_message`
// column so caller code (HTTP handlers / scheduled handler) never throws.
// ============================================================================

import { createQueries } from "../db/queries";
import { parseRss } from "./rss";

// Mirror md5.ts's hex-out signature without pulling node:crypto in.
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function podcastChannelId(seed: string): string {
  // Synchronous deterministic id seed for createPodcastChannel. We keep this
  // hex-only so the 10-char slice never collides with the `pc-` / `pe-` prefix.
  // Caller passes the URL; same URL → same id (DB UNIQUE catches duplicates).
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h * 31) + seed.charCodeAt(i)) & 0xffffffff;
  // Use UUID + URL hash so two different URLs never share an id even if seeds
  // hash equal (rare). The UUID part keeps probability negligible.
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return "pc-" + (hex + uuid).slice(0, 12);
}

export function podcastEpisodeId(channelId: string, guid: string): string {
  // We want deterministic ids so the same (channel, guid) always maps to the
  // same row even after refresh — UPSERT keys on (channel_id, guid) anyway,
  // but the id column is the primary key clients persist.
  return "pe-" + (channelId + ":" + guid)
    .split("")
    .reduce((a, c) => (a * 33 + c.charCodeAt(0)) & 0xffffffff, 5381)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8) + crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}

// Stable channel id helper that survives across refreshes (asynchronous).
// Used inside refreshChannel — we want the same row id, not a fresh UUID.
export async function stableEpisodeId(channelId: string, guid: string): Promise<string> {
  const hash = await sha1Hex(channelId + "|" + guid);
  return "pe-" + hash.slice(0, 14);
}

// ============================================================================
// refreshChannel — pulls one feed and writes back into D1.
// ----------------------------------------------------------------------------
// Returns the number of episodes inserted/updated. On failure the channel row
// is flipped to status='error' with the failure message; never throws.
// ============================================================================
export async function refreshChannel(
  db: D1Database,
  channelId: string,
  // Optional fetch impl to make this testable without monkey-patching globals.
  fetchImpl: typeof fetch = fetch,
): Promise<{ episodes: number; status: "completed" | "error"; error?: string }> {
  const queries = createQueries(db);
  const channel = await queries.getPodcastChannel(channelId);
  if (!channel) {
    return { episodes: 0, status: "error", error: "Channel not found" };
  }

  const now = Math.floor(Date.now() / 1000);

  let xml: string;
  try {
    const resp = await fetchImpl(channel.url, {
      headers: { "User-Agent": "EdgeSonic/1.0 PodcastFetcher (+https://edgesonic.example/)" },
    });
    if (!resp.ok) {
      const msg = `RSS fetch failed: HTTP ${resp.status}`;
      await queries.updatePodcastChannel(channelId, {
        status: "error",
        errorMessage: msg,
        lastRefreshedAt: now,
      });
      return { episodes: 0, status: "error", error: msg };
    }
    xml = await resp.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await queries.updatePodcastChannel(channelId, {
      status: "error",
      errorMessage: msg,
      lastRefreshedAt: now,
    });
    return { episodes: 0, status: "error", error: msg };
  }

  let parsed;
  try {
    parsed = parseRss(xml);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await queries.updatePodcastChannel(channelId, {
      status: "error",
      errorMessage: `Parse error: ${msg}`,
      lastRefreshedAt: now,
    });
    return { episodes: 0, status: "error", error: msg };
  }

  // Channel meta first; once meta lands the row is `completed` even if an
  // individual item insert later fails.
  await queries.updatePodcastChannel(channelId, {
    title: parsed.title,
    description: parsed.description,
    imageUrl: parsed.imageUrl,
    language: parsed.language,
    status: "completed",
    errorMessage: null,
    lastRefreshedAt: now,
  });

  let written = 0;
  for (const item of parsed.items) {
    if (!item.guid || !item.audioUrl) continue;     // skip ungroupable items
    const id = await stableEpisodeId(channelId, item.guid);
    try {
      await queries.upsertPodcastEpisode({
        id,
        channelId,
        guid: item.guid,
        title: item.title,
        description: item.description,
        audioUrl: item.audioUrl,
        publishedAt: item.publishedAt,
        duration: item.duration,
        size: item.size,
        bitRate: null,             // RSS doesn't carry bitrate; populated on download
      });
      written++;
    } catch (e) {
      // Don't blow up the whole refresh on one bad item.
      console.error(`upsertPodcastEpisode failed for ${item.guid}:`, e);
    }
  }

  return { episodes: written, status: "completed" };
}

// ============================================================================
// refreshAllChannels — fan out one refreshChannel per row.
// Used by the Cron Trigger and the manual /rest/refreshPodcasts endpoint.
// Sequential to keep subrequest budget in check on the free tier.
// ============================================================================
export async function refreshAllChannels(
  db: D1Database,
  fetchImpl: typeof fetch = fetch,
): Promise<{ channels: number; episodes: number; errors: number }> {
  const queries = createQueries(db);
  const channels = await queries.listPodcastChannels();
  let episodes = 0;
  let errors = 0;
  for (const ch of channels) {
    const r = await refreshChannel(db, ch.id, fetchImpl);
    episodes += r.episodes;
    if (r.status === "error") errors++;
  }
  return { channels: channels.length, episodes, errors };
}

// ============================================================================
// downloadEpisodeToR2 — pulls the enclosure URL into R2.
// ----------------------------------------------------------------------------
// Lifecycle: episode.status transitions
//   new → downloading → completed | error
// The R2 key uses /podcasts/{channelId}/{episodeId}.{suffix} to keep podcast
// bytes out of the music R2 namespace conventions (Schema.sql §R2 Convention).
// ============================================================================
export async function downloadEpisodeToR2(
  db: D1Database,
  bucket: R2Bucket,
  episodeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "completed" | "error"; key?: string; error?: string }> {
  const queries = createQueries(db);
  const ep = await queries.getPodcastEpisode(episodeId);
  if (!ep) return { status: "error", error: "Episode not found" };
  if (!ep.audio_url) {
    await queries.updatePodcastEpisodeStatus(episodeId, {
      status: "error", errorMessage: "Episode has no audio_url",
    });
    return { status: "error", error: "No audio_url" };
  }

  await queries.updatePodcastEpisodeStatus(episodeId, { status: "downloading" });

  try {
    const resp = await fetchImpl(ep.audio_url, {
      headers: { "User-Agent": "EdgeSonic/1.0 PodcastFetcher" },
    });
    if (!resp.ok) {
      const msg = `Download failed: HTTP ${resp.status}`;
      await queries.updatePodcastEpisodeStatus(episodeId, {
        status: "error", errorMessage: msg,
      });
      return { status: "error", error: msg };
    }

    // Pull the whole body into memory. Podcast episodes are usually < 200MB;
    // workers without the streaming R2 put binding can't stream into R2.
    const buf = await resp.arrayBuffer();
    const suffix = guessSuffix(ep.audio_url, resp.headers.get("Content-Type"));
    const key = `podcasts/${ep.channel_id}/${episodeId}${suffix}`;

    await bucket.put(key, buf, {
      httpMetadata: {
        contentType: resp.headers.get("Content-Type") || "audio/mpeg",
      },
    });

    await queries.updatePodcastEpisodeStatus(episodeId, {
      status: "completed",
      downloadedR2Key: key,
      errorMessage: null,
      size: buf.byteLength,
    });
    return { status: "completed", key };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await queries.updatePodcastEpisodeStatus(episodeId, {
      status: "error", errorMessage: msg,
    });
    return { status: "error", error: msg };
  }
}

// Best-effort suffix from URL or Content-Type. Default to .mp3 — the de-facto
// podcast format — so the R2 key always has *some* extension.
function guessSuffix(url: string, contentType: string | null): string {
  const fromUrl = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url)?.[1]?.toLowerCase();
  if (fromUrl && ["mp3", "m4a", "ogg", "opus", "aac", "wav", "flac"].includes(fromUrl)) {
    return "." + fromUrl;
  }
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("mpeg")) return ".mp3";
    if (ct.includes("mp4") || ct.includes("aac")) return ".m4a";
    if (ct.includes("ogg")) return ".ogg";
    if (ct.includes("opus")) return ".opus";
    if (ct.includes("flac")) return ".flac";
    if (ct.includes("wav")) return ".wav";
  }
  return ".mp3";
}
