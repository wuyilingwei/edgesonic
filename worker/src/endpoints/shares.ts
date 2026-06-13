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
import { createQueries } from "../db/queries";
import { subsonicOK } from "../utils/xml";
import { mapShareDetail } from "../types/subsonic";
import { permissionMiddleware, subsonicError } from "../auth";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { createSubsonicAdapter } from "../adapters/subsonic";
import { getFeature, parseChain } from "../utils/features";
import type { StreamResult } from "../adapters/index";
import type { User } from "../types/entities";

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
// GET /share/:id  —  public byte stream of the first entry
// ----------------------------------------------------------------------------
// Bypasses authMiddleware because it sits outside /rest/* (authMiddleware is
// bound to /rest/* in index.ts). We deliberately do NOT 302-redirect to
// /rest/stream because that endpoint demands Subsonic credentials we cannot
// attach on behalf of the anonymous caller. Instead we re-use the storage
// adapters directly — the policy boundary (expiry + view counting) lives
// inside this handler.
//
// Picks the best song_instance via the same heuristic as media.ts /rest/stream
// (prefer larger bit-rate; prefer flac; prefer local). Range header is
// honoured by the adapter chain. Transcoding is intentionally skipped — the
// public share is meant to be "press play and listen to the original".
// ============================================================================
sharesRoutes.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const env = c.env as Env;
  const queries = createQueries(env.DB);

  const share = await queries.getShareById(id);
  if (!share) {
    return c.text("Share not found", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // Expiry check (unix seconds). `expires_at = NULL` means never expires.
  const now = Math.floor(Date.now() / 1000);
  if (share.expires_at !== null && share.expires_at < now) {
    return c.text("Share has expired", 410, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  const songs = await queries.getShareEntries(id);
  if (songs.length === 0) {
    return c.text("Share has no entries", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // v1 — single-song streaming. The first entry wins; multi-song shares act
  // as a playlist where extra entries are visible via getShares but only the
  // first is reachable through the public link. Clients with EdgeSonic
  // credentials can hit /rest/stream for the rest.
  const first = songs[0];
  const instances = await queries.getSongInstances(first.id);
  if (instances.length === 0) {
    return c.text("Shared song has no playable source", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // Same preference order as /rest/stream — prefer flac, then highest
  // bitrate, then local source.
  let selected = instances[0];
  for (const inst of instances) {
    if (inst.suffix === selected.suffix && (inst.bit_rate || 0) > (selected.bit_rate || 0)) selected = inst;
    if (inst.suffix === "flac" && selected.suffix !== "flac") selected = inst;
    if (inst.source_id === "local" && selected.source_id !== "local") selected = inst;
  }

  // Increment view count before opening the stream so partial reads still
  // get audited. The +1 is best-effort (we don't await its outcome to gate
  // the response); failure to log a view should never break playback.
  c.executionCtx?.waitUntil?.(queries.incrementShareView(id));

  const parsed = parseStorageUri(selected.storage_uri);
  const range = c.req.header("Range") || undefined;
  let result: StreamResult;

  switch (parsed.scheme) {
    case "r2":
      result = await createR2Adapter(env.MUSIC_BUCKET).stream(selected.storage_uri, range);
      break;
    case "url":
      result = await urlAdapter.stream(selected.storage_uri, range);
      break;
    case "webdav":
      result = await createWebDAVAdapter(env.DB).stream(selected.storage_uri, range);
      break;
    case "subsonic": {
      if (!(await getFeature(env, "enable_subsonic_upstream"))) {
        return c.text("Subsonic upstream sources are disabled", 403, { "Content-Type": "text/plain; charset=UTF-8" });
      }
      // Public route still carries an esChain so an upstream EdgeSonic can
      // detect loops; the chain is whatever the client provided (typically
      // empty for browser visits).
      const incomingChain = parseChain(c.req.query("esChain") || c.req.header("X-EdgeSonic-Chain"));
      result = await createSubsonicAdapter(env.DB, {
        instanceId: env.INSTANCE_ID,
        incomingChain,
      }).stream(selected.storage_uri, range);
      break;
    }
    default:
      return c.text("Unsupported storage scheme", 500, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  if (!result.body || result.statusCode >= 400) {
    return c.body(null, result.statusCode as never);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.contentType);
  if (result.contentLength) headers.set("Content-Length", String(result.contentLength));
  if (result.acceptRanges) headers.set("Accept-Ranges", "bytes");
  if (result.contentRange) headers.set("Content-Range", result.contentRange);
  // Tag the response so middleboxes (and the verify pass in 048) can identify
  // share-served traffic vs the authenticated /rest/stream pathway.
  headers.set("X-EdgeSonic-Share", id);

  return new Response(result.body, { status: result.statusCode, headers });
});

// ============================================================================
// Route registration. Each handler is bound to both `/rest/<name>` and the
// `.view` legacy suffix × {GET, POST}. The public /share/:id is registered
// directly above and not exposed through `register`.
// ============================================================================
function register(
  path: string,
  middleware: ReturnType<typeof permissionMiddleware> | null,
  handler: (c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>) => Promise<Response>,
) {
  const paths = [`/rest/${path}`, `/rest/${path}.view`];
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
