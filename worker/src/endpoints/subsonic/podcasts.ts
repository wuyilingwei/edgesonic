// ============================================================================
// ----------------------------------------------------------------------------
//   GET           /rest/getPodcasts(.view)            [id?, includeEpisodes?]
//   GET           /rest/getNewestPodcasts(.view)      [count?]
//   GET           /rest/getPodcastEpisode(.view)      [id]
//   GET           /rest/refreshPodcasts(.view)        (admin)
//   GET/POST      /rest/createPodcastChannel(.view)   [url]                (admin)
//   GET/POST      /rest/deletePodcastChannel(.view)   [id]                 (admin)
//   GET/POST      /rest/deletePodcastEpisode(.view)   [id]                 (admin)
//   GET/POST      /rest/downloadPodcastEpisode(.view) [id]                 (admin)
//
// Admin endpoints additionally require the `manage_podcasts` permission and
// pass through the auth middleware's SESSION_ONLY guard (see auth.ts).
// ============================================================================

import { Hono } from "hono";
import type { Context } from "hono";
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import {
  mapPodcastChannel,
  mapPodcastEpisode,
  type SubsonicPodcastChannel,
  type SubsonicPodcastEpisode,
} from "../../types/subsonic";
import { subsonicError, permissionMiddleware } from "../../auth";
import {
  podcastChannelId,
  refreshChannel,
  refreshAllChannels,
  downloadEpisodeToR2,
} from "../../utils/podcastSync";
import type { User, PodcastChannel, PodcastEpisode } from "../../types/entities";

export const podcastsRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// ============================================================================
// GET + POST param merge (mirrors bookmarks.ts pattern)
// ============================================================================
type ParamMap = Map<string, string[]>;

async function readParams(c: Context): Promise<ParamMap> {
  const map: ParamMap = new Map();
  const push = (k: string, v: string) => {
    const arr = map.get(k);
    if (arr) arr.push(v);
    else map.set(k, [v]);
  };

  const url = new URL(c.req.url);
  url.searchParams.forEach((v, k) => push(k, v));

  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody({ all: true });
      for (const [k, raw] of Object.entries(body)) {
        if (raw === undefined || raw === null) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        for (const v of values) {
          if (typeof v === "string") push(k, v);
        }
      }
    } catch {
      /* not form-encoded — ignore */
    }
  }
  return map;
}

function getFirst(p: ParamMap, name: string): string | undefined {
  const arr = p.get(name);
  return arr && arr.length > 0 ? arr[0] : undefined;
}

function parseBool(s: string | undefined, defaultValue: boolean): boolean {
  if (s === undefined) return defaultValue;
  return s === "true" || s === "1" || s === "yes";
}

function parseIntDefault(s: string | undefined, defaultValue: number): number {
  if (s === undefined || s === "") return defaultValue;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

// ============================================================================
// Response shape helpers
// ----------------------------------------------------------------------------
// `channel` carries its attributes plus a nested list of <episode/> elements
// when includeEpisodes is true. Our XML builder turns attribute-only children
// into self-closing tags when given { _attributes: {...} } only.
// ============================================================================
function channelNode(
  channel: PodcastChannel,
  episodes: PodcastEpisode[] | null,
): Record<string, unknown> {
  const channelAttrs = mapPodcastChannel(channel);
  const node: Record<string, unknown> = {
    _attributes: channelAttrs as unknown as Record<
      string, string | number | boolean | undefined
    >,
  };
  if (episodes !== null) {
    node.episode = episodes.map((e) =>
      attrs(mapPodcastEpisode(e, channel) as unknown as Record<
        string, string | number | boolean | undefined
      >),
    );
  }
  return node;
}

function episodeNode(
  episode: PodcastEpisode,
  channel: PodcastChannel | undefined,
): Record<string, unknown> {
  return attrs(mapPodcastEpisode(episode, channel) as unknown as Record<
    string, string | number | boolean | undefined
  >);
}

// ============================================================================
// /rest/getPodcasts
//   Params: id? (channel id), includeEpisodes? (boolean, default true)
// ============================================================================
const getPodcastsHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const id = getFirst(params, "id");
  const includeEpisodes = parseBool(getFirst(params, "includeEpisodes"), true);
  const queries = createQueries(c.env.DB);

  let channels: PodcastChannel[];
  if (id) {
    const one = await queries.getPodcastChannel(id);
    if (!one) return c.text(subsonicError(70, "Podcast channel not found"), 404, XML);
    channels = [one];
  } else {
    channels = await queries.listPodcastChannels();
  }

  const channelNodes: Record<string, unknown>[] = [];
  for (const ch of channels) {
    const eps = includeEpisodes ? await queries.listPodcastEpisodes(ch.id) : null;
    channelNodes.push(channelNode(ch, eps));
  }

  return c.text(
    subsonicOK({
      podcasts: {
        channel: channelNodes,
      },
    }),
    200, XML,
  );
};

// ============================================================================
// /rest/getNewestPodcasts
//   Params: count? (default 20)
// ============================================================================
const getNewestPodcastsHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const count = Math.max(1, Math.min(500, parseIntDefault(getFirst(params, "count"), 20)));
  const queries = createQueries(c.env.DB);

  const episodes = await queries.listNewestEpisodes(count);
  // Look up parent channels in one pass so coverArt can be attached.
  const channelIds = Array.from(new Set(episodes.map((e) => e.channel_id)));
  const channelById = new Map<string, PodcastChannel>();
  for (const id of channelIds) {
    const ch = await queries.getPodcastChannel(id);
    if (ch) channelById.set(id, ch);
  }

  return c.text(
    subsonicOK({
      newestPodcasts: {
        episode: episodes.map((e) => episodeNode(e, channelById.get(e.channel_id))),
      },
    }),
    200, XML,
  );
};

// ============================================================================
// /rest/getPodcastEpisode (OpenSubsonic extension)
//   Params: id (episode id)
// ============================================================================
const getPodcastEpisodeHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const id = getFirst(params, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);

  const queries = createQueries(c.env.DB);
  const episode = await queries.getPodcastEpisode(id);
  if (!episode) return c.text(subsonicError(70, "Podcast episode not found"), 404, XML);
  const channel = await queries.getPodcastChannel(episode.channel_id);

  return c.text(
    subsonicOK({
      podcastEpisode: {
        episode: [episodeNode(episode, channel ?? undefined)],
      },
    }),
    200, XML,
  );
};

// ============================================================================
// /rest/refreshPodcasts — admin trigger; non-blocking via ctx.waitUntil.
// ============================================================================
const refreshPodcastsHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const exec = c.executionCtx;
  // Don't await — return immediately; refresh continues in the background.
  exec.waitUntil(refreshAllChannels(c.env.DB).catch((e) => {
    console.error("refreshAllChannels failed:", e);
  }));
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/createPodcastChannel
//   Params: url (required)
//   Behaviour: create the row (status=new) and kick off a refresh in the
//   background; client polls getPodcasts for the populated meta + episodes.
// ============================================================================
const createPodcastChannelHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const url = getFirst(params, "url");
  if (!url) return c.text(subsonicError(10, "Required parameter is missing: url"), 400, XML);

  // Quick URL sanity — Subsonic doesn't validate, we just reject obvious junk.
  if (!/^https?:\/\//i.test(url)) {
    return c.text(subsonicError(10, "Invalid url (must be http(s)://...)"), 400, XML);
  }

  const queries = createQueries(c.env.DB);
  const existing = await queries.getPodcastChannelByUrl(url);
  if (existing) {
    return c.text(subsonicError(0, "Podcast channel already exists"), 400, XML);
  }

  const id = podcastChannelId(url);
  await queries.insertPodcastChannel({ id, url });
  // Sync RSS in the background so clients see episodes on their next poll.
  c.executionCtx.waitUntil(refreshChannel(c.env.DB, id).catch((e) => {
    console.error(`refreshChannel(${id}) failed:`, e);
  }));
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/deletePodcastChannel
//   Params: id
// ============================================================================
const deletePodcastChannelHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const id = getFirst(params, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);

  const queries = createQueries(c.env.DB);
  const changes = await queries.deletePodcastChannel(id);
  if (changes === 0) {
    return c.text(subsonicError(70, "Podcast channel not found"), 404, XML);
  }
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/deletePodcastEpisode
//   Params: id
// ============================================================================
const deletePodcastEpisodeHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const id = getFirst(params, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);

  const queries = createQueries(c.env.DB);
  // Drop the R2 blob too if it was downloaded — keeps the bucket tidy.
  const ep = await queries.getPodcastEpisode(id);
  if (ep?.downloaded_r2_key) {
    try { await c.env.MUSIC_BUCKET.delete(ep.downloaded_r2_key); }
    catch (e) { console.error(`R2 delete ${ep.downloaded_r2_key} failed:`, e); }
  }
  const changes = await queries.deletePodcastEpisode(id);
  if (changes === 0) {
    return c.text(subsonicError(70, "Podcast episode not found"), 404, XML);
  }
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// /rest/downloadPodcastEpisode
//   Params: id
//   Non-blocking: status flips new → downloading immediately, R2 write runs in
//   ctx.waitUntil and finalises status → completed | error.
// ============================================================================
const downloadPodcastEpisodeHandler = async (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const params = await readParams(c);
  const id = getFirst(params, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter is missing: id"), 400, XML);

  const queries = createQueries(c.env.DB);
  const episode = await queries.getPodcastEpisode(id);
  if (!episode) return c.text(subsonicError(70, "Podcast episode not found"), 404, XML);
  if (episode.status === "downloading") {
    // Idempotent — return OK so re-triggers from impatient clients are safe.
    return c.text(subsonicOK({}), 200, XML);
  }
  if (!episode.audio_url) {
    return c.text(subsonicError(0, "Episode has no audio_url"), 400, XML);
  }

  // Flip the status synchronously so polling sees `downloading` straight away.
  await queries.updatePodcastEpisodeStatus(id, { status: "downloading" });
  c.executionCtx.waitUntil(
    downloadEpisodeToR2(c.env.DB, c.env.MUSIC_BUCKET, id).catch((e) => {
      console.error(`downloadEpisodeToR2(${id}) failed:`, e);
    }),
  );

  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration
// ----------------------------------------------------------------------------
// Subsonic clients hit both /rest/<name> and the legacy `.view` suffix; both
// GET and POST are valid per spec. Admin endpoints additionally hop through
// permissionMiddleware('manage_podcasts').
// ============================================================================
type Handler = (
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
) => Promise<Response>;

function register(
  path: string,
  middleware: ReturnType<typeof permissionMiddleware> | null,
  handler: Handler,
) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    if (middleware) {
      podcastsRoutes.get(p, middleware, handler);
      podcastsRoutes.post(p, middleware, handler);
    } else {
      podcastsRoutes.get(p, handler);
      podcastsRoutes.post(p, handler);
    }
  }
}

// Read-only — any authenticated user.
register("getPodcasts", null, getPodcastsHandler);
register("getNewestPodcasts", null, getNewestPodcastsHandler);
register("getPodcastEpisode", null, getPodcastEpisodeHandler);

// Admin — manage_podcasts permission + SESSION_ONLY (declared in auth.ts).
register("refreshPodcasts", permissionMiddleware("manage_podcasts"), refreshPodcastsHandler);
register("createPodcastChannel", permissionMiddleware("manage_podcasts"), createPodcastChannelHandler);
register("deletePodcastChannel", permissionMiddleware("manage_podcasts"), deletePodcastChannelHandler);
register("deletePodcastEpisode", permissionMiddleware("manage_podcasts"), deletePodcastEpisodeHandler);
register("downloadPodcastEpisode", permissionMiddleware("manage_podcasts"), downloadPodcastEpisodeHandler);

// Re-exports of Subsonic shapes — convenient for callers / tests.
export type { SubsonicPodcastChannel, SubsonicPodcastEpisode };
