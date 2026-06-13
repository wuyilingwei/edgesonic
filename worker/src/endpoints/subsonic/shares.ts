// 044 Sharing — Subsonic share API.
//
// Provides:
//   GET            /rest/getShares           — list caller's shares + entries
//   GET|POST       /rest/createShare         — new share targeting ≥1 song
//                                              (album ids are expanded into
//                                              their constituent song masters)
//   GET|POST       /rest/updateShare         — patch description / expires
//   GET|POST       /rest/deleteShare         — owner or admin
//   GET            /share/:id                — public byte stream of the first
//                                              entry; bypasses Subsonic auth
//                                              because it's outside /rest/*
//                                              (see auth.ts — authMiddleware is
//                                              bound to /rest/* in index.ts).
//
// `expires` is accepted in **milliseconds** per Subsonic spec, but stored as
// unix seconds internally to align with every other timestamp in the schema.

import { Hono } from "hono";
import { createQueries } from "../../db/queries";
import { subsonicOK } from "../../utils/xml";
import { mapShareDetail } from "../../types/subsonic";
import { permissionMiddleware, subsonicError } from "../../auth";
import type { User } from "../../types/entities";

export const sharesRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({ _attributes: o as Record<string, string | number | boolean | undefined> });

// ============================================================================
// Multi-value / single-field param helpers — Subsonic clients send repeated
// keys as either query params (?id=A&id=B) or form fields (POST).
// Lifted from playlists.ts to keep the helper local and import-free.
// ============================================================================
async function readMulti(c: import("hono").Context, name: string): Promise<string[]> {
  const fromQuery = c.req.queries(name);
  if (fromQuery && fromQuery.length > 0) return fromQuery.filter((v) => v !== "");

  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody({ all: true });
      const raw = body[name];
      if (raw === undefined) return [];
      if (Array.isArray(raw)) return raw.map((v) => String(v)).filter((v) => v !== "");
      return [String(raw)].filter((v) => v !== "");
    } catch {
      return [];
    }
  }
  return [];
}

async function readField(c: import("hono").Context, name: string): Promise<string | undefined> {
  const fromQuery = c.req.query(name);
  if (fromQuery !== undefined) return fromQuery;
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      const raw = body[name];
      if (raw === undefined) return undefined;
      return Array.isArray(raw) ? String(raw[0]) : String(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Build the absolute public share URL from the incoming request's origin.
// Subsonic spec mandates this be a fully-qualified URL so Settings UIs (and
// share-to-clipboard buttons in clients) can hand it off without rewriting.
function buildShareUrl(c: import("hono").Context, shareId: string): string {
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}/share/${shareId}`;
}

// Resolve a mixed list of "song" / "album" / raw song_master ids into an
// ordered, deduped list of song_master ids. Album ids expand to all their
// song masters (track order). Unknown ids are silently dropped — Subsonic
// clients sometimes send stale ids; failing the whole call would be hostile.
async function expandTargetIds(
  queries: ReturnType<typeof createQueries>,
  rawIds: string[],
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of rawIds) {
    // Album ids in EdgeSonic are prefixed `al-`; everything else is treated
    // as a song_master id and validated via getSongMaster.
    if (id.startsWith("al-")) {
      const songs = await queries.getSongMastersByAlbum(id);
      for (const s of songs) {
        if (!seen.has(s.id)) { seen.add(s.id); out.push(s.id); }
      }
    } else {
      const song = await queries.getSongMaster(id);
      if (song && !seen.has(song.id)) { seen.add(song.id); out.push(song.id); }
    }
  }
  return out;
}

// Parse `expires` query param (milliseconds per Subsonic spec).
//   undefined          → patch absent (caller decides default)
//   ""                 → explicit clear (return null)
//   "0"                → also clear (Subsonic clients send "0" to mean
//                                    "never expires")
//   <ms>               → unix seconds
// Returns:
//   { present: false } when undefined
//   { present: true, value: number | null } otherwise
function parseExpiresMs(raw: string | undefined): { present: false } | { present: true; value: number | null } {
  if (raw === undefined) return { present: false };
  if (raw === "" || raw === "0") return { present: true, value: null };
  const ms = parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms <= 0) return { present: true, value: null };
  return { present: true, value: Math.floor(ms / 1000) };
}

// ============================================================================
// GET /rest/getShares
// ============================================================================
// Lists shares owned by the caller. Admin (level=3) sees every share so the
// Settings audit view can render the full set.
const getSharesHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const queries = createQueries(c.env.DB);
  const shares = await queries.getSharesForUser(user.username, user.level === 3);

  const sharePayload: Array<{
    _attributes: Record<string, string | number | boolean | undefined>;
    entry: Array<{ _attributes: Record<string, string | number | boolean | undefined> }>;
  }> = [];

  for (const s of shares) {
    const songs = await queries.getShareEntries(s.id);
    const detail = mapShareDetail(s, buildShareUrl(c, s.id), songs);
    sharePayload.push({
      _attributes: detail.attrs as unknown as Record<string, string | number | boolean | undefined>,
      entry: detail.entries.map((e) => attrs(e)),
    });
  }

  return c.text(
    subsonicOK({ shares: { share: sharePayload } }),
    200, XML,
  );
};

// ============================================================================
// GET|POST /rest/createShare
// ============================================================================
// Params: `id` (multi-value; song or album ids) / `description?` / `expires?` (ms)
const createShareHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const ids = await readMulti(c, "id");
  if (ids.length === 0) {
    return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);
  }
  const description = await readField(c, "description");
  const expiresRaw = await readField(c, "expires");
  const expires = parseExpiresMs(expiresRaw);

  const queries = createQueries(c.env.DB);
  const songIds = await expandTargetIds(queries, ids);
  if (songIds.length === 0) {
    return c.text(subsonicError(70, "No valid target found for share"), 404, XML);
  }

  const shareId = crypto.randomUUID().substring(0, 12);
  await queries.createShare({
    id: shareId,
    userId: user.username,
    description: description ?? null,
    expiresAt: expires.present ? expires.value : null,
    songIds,
  });

  const created = await queries.getShareById(shareId);
  if (!created) {
    return c.text(subsonicError(0, "Share creation failed"), 500, XML);
  }
  const songs = await queries.getShareEntries(shareId);
  const detail = mapShareDetail(created, buildShareUrl(c, shareId), songs);

  return c.text(
    subsonicOK({
      shares: {
        share: {
          _attributes: detail.attrs as unknown as Record<string, string | number | boolean | undefined>,
          entry: detail.entries.map((e) => attrs(e)),
        },
      },
    }),
    200, XML,
  );
};

// ============================================================================
// GET|POST /rest/updateShare
// ============================================================================
// Params: `id` (share id) / `description?` / `expires?` (ms)
const updateShareHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const id = await readField(c, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);

  const queries = createQueries(c.env.DB);
  const existing = await queries.getShareById(id);
  if (!existing) return c.text(subsonicError(70, "Share not found"), 404, XML);
  if (existing.user_id !== user.username && user.level !== 3) {
    return c.text(subsonicError(50, "Not authorized to modify this share"), 403, XML);
  }

  const descRaw = await readField(c, "description");
  const expiresRaw = await readField(c, "expires");
  const expires = parseExpiresMs(expiresRaw);

  await queries.updateShareMeta(id, {
    // Empty string clears description; matches Subsonic spec for nullable
    // metadata fields.
    description: descRaw === undefined ? undefined : (descRaw === "" ? null : descRaw),
    expiresAt: expires.present ? expires.value : undefined,
  });

  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// GET|POST /rest/deleteShare
// ============================================================================
const deleteShareHandler = async (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => {
  const user = c.get("user");
  const id = await readField(c, "id");
  if (!id) return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);

  const queries = createQueries(c.env.DB);
  const existing = await queries.getShareById(id);
  if (!existing) return c.text(subsonicError(70, "Share not found"), 404, XML);
  if (existing.user_id !== user.username && user.level !== 3) {
    return c.text(subsonicError(50, "Not authorized to delete this share"), 403, XML);
  }

  await queries.deleteShare(id);
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration. Each handler is bound to both `/<name>` and the
// `.view` legacy suffix × {GET, POST}. The public /share/:id was extracted to
// endpoints/share_public.ts during the 055 refactor.
// ============================================================================
function register(
  path: string,
  middleware: ReturnType<typeof permissionMiddleware> | null,
  handler: (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => Promise<Response>,
) {
  const paths = [`/${path}`, `/${path}.view`];
  for (const p of paths) {
    if (middleware) {
      sharesRoutes.get(p, middleware, handler);
      sharesRoutes.post(p, middleware, handler);
    } else {
      sharesRoutes.get(p, handler);
      sharesRoutes.post(p, handler);
    }
  }
}

// getShares is read-only; permitted to any authenticated user (visibility is
// scoped to caller's own shares inside the handler).
register("getShares", null, getSharesHandler);
register("createShare", permissionMiddleware("share"), createShareHandler);
register("updateShare", permissionMiddleware("share"), updateShareHandler);
register("deleteShare", permissionMiddleware("share"), deleteShareHandler);
