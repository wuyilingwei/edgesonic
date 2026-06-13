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

// 044 — Public share route, extracted out of subsonic/shares.ts during the 055
// API refactor. It sits OUTSIDE /rest/* so authMiddleware can't intercept it,
// and outside the new /tag /storage /edgesonic buckets too — anonymous visitors
// must be able to press play without any credentials.
//
// 075 — Default response is now a simple HTML page (title, audio control,
// metadata) so that opening the link in a browser shows context instead of a
// raw byte stream. The actual audio bytes moved to `?stream=1` so the inline
// <audio src> still works. Audio-only clients (VLC etc.) hit `?stream=1`
// directly; UA sniffing intentionally not implemented (see task 075 Part C).
import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { parseStorageUri } from "../adapters/index";
import { createR2Adapter } from "../adapters/r2";
import { urlAdapter } from "../adapters/url";
import { createWebDAVAdapter } from "../adapters/webdav";
import { createSubsonicAdapter } from "../adapters/subsonic";
import { getFeature, parseChain } from "../utils/features";
import type { StreamResult } from "../adapters/index";
import type { Share, SongMaster } from "../types/entities";

export const sharePublicRoutes = new Hono();

// HTML entity escape for user-controlled fields (description, song title,
// share id from URL). Covers the OWASP basic set; we don't render into
// attribute contexts beyond the audio src (which only carries our own id).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatExpires(unixSeconds: number): string {
  // ISO-8601 in UTC; readable enough for a debug-style landing page without
  // pulling in a locale formatter on the worker side.
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface RenderInput {
  shareId: string;
  description: string | null;
  expiresAt: number | null;
  viewCount: number;
  entryCount: number;
  firstSongTitle: string | null;
}

function renderShareHtml(input: RenderInput): string {
  const safeId = escapeHtml(input.shareId);
  const title = input.description?.trim() || input.firstSongTitle?.trim() || `EdgeSonic Share ${input.shareId}`;
  const safeTitle = escapeHtml(title);
  const subtitle = input.description?.trim()
    ? (input.firstSongTitle ? escapeHtml(input.firstSongTitle) : `${input.entryCount} track${input.entryCount === 1 ? "" : "s"}`)
    : `${input.entryCount} track${input.entryCount === 1 ? "" : "s"}`;
  const expiresLine = input.expiresAt === null
    ? "永久有效 · never expires"
    : `过期时间 · expires ${escapeHtml(formatExpires(input.expiresAt))}`;
  // view_count we render reflects the value BEFORE this hit's waitUntil lands;
  // good enough for a landing page (+1 stale by one render is acceptable).
  const viewLine = `已访问 ${input.viewCount} 次 · viewed ${input.viewCount} time${input.viewCount === 1 ? "" : "s"}`;

  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>EdgeSonic · ${safeTitle}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, sans-serif;
      background: #0a0a0b;
      color: #e4e4e7;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1.5rem;
      line-height: 1.6;
    }
    .card {
      max-width: 600px;
      width: 100%;
      padding: 2rem;
      background: #111113;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      position: relative;
    }
    .corner {
      position: absolute;
      width: 12px;
      height: 12px;
      pointer-events: none;
      border-color: rgba(255, 255, 255, 0.15);
    }
    .corner-tl { top: 0; left: 0; border-top: 2px solid; border-left: 2px solid; }
    .corner-tr { top: 0; right: 0; border-top: 2px solid; border-right: 2px solid; }
    .corner-bl { bottom: 0; left: 0; border-bottom: 2px solid; border-left: 2px solid; }
    .corner-br { bottom: 0; right: 0; border-bottom: 2px solid; border-right: 2px solid; }
    .label {
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #71717a;
      margin-bottom: 0.4rem;
    }
    h1 {
      font-size: 1.4rem;
      font-weight: 600;
      margin: 0 0 0.4rem 0;
      color: #ffffff;
      word-break: break-word;
    }
    .meta {
      color: #a1a1aa;
      font-size: 0.88rem;
      margin-bottom: 1.5rem;
      word-break: break-word;
    }
    audio {
      width: 100%;
      margin: 0.5rem 0 1.25rem 0;
      filter: invert(0.95) hue-rotate(180deg);
    }
    .footer {
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 0.74rem;
      letter-spacing: 0.08em;
      color: #71717a;
      margin-top: 1.25rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 1rem;
      line-height: 1.8;
    }
    .footer .row { display: block; }
    .brand {
      color: #ffffff;
      text-decoration: none;
      letter-spacing: 0.1em;
    }
    .brand:hover { color: #a1a1aa; }
  </style>
</head>
<body>
  <main class="card">
    <span class="corner corner-tl"></span>
    <span class="corner corner-tr"></span>
    <span class="corner corner-bl"></span>
    <span class="corner corner-br"></span>
    <div class="label">// EdgeSonic Share //</div>
    <h1>${safeTitle}</h1>
    <div class="meta">${subtitle}</div>
    <audio controls preload="metadata" src="/share/${safeId}?stream=1"></audio>
    <div class="footer">
      <span class="row">${expiresLine}</span>
      <span class="row">${viewLine}</span>
      <span class="row">// <a class="brand" href="/">EdgeSonic</a> //</span>
    </div>
  </main>
</body>
</html>
`;
}

sharePublicRoutes.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const env = c.env as Env;
  const queries = createQueries(env.DB);

  const share: Share | null = await queries.getShareById(id);
  if (!share) {
    return c.text("Share not found", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  // Expiry check (unix seconds). `expires_at = NULL` means never expires.
  const now = Math.floor(Date.now() / 1000);
  if (share.expires_at !== null && share.expires_at < now) {
    return c.text("Share has expired", 410, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  const songs: SongMaster[] = await queries.getShareEntries(id);
  if (songs.length === 0) {
    return c.text("Share has no entries", 404, { "Content-Type": "text/plain; charset=UTF-8" });
  }

  const streamMode = c.req.query("stream") === "1";

  // Both branches bump view_count. We do it once here so the HTML landing
  // page reflects visits as well as audio fetches; the audio element will
  // itself trigger a second hit for `?stream=1` which is the desired
  // behaviour (a successful play counts independently of the page view).
  c.executionCtx?.waitUntil?.(queries.incrementShareView(id));

  // ----- HTML branch (default — browsers, link previews) -----
  if (!streamMode) {
    const html = renderShareHtml({
      shareId: id,
      description: share.description,
      expiresAt: share.expires_at,
      viewCount: share.view_count,
      entryCount: songs.length,
      firstSongTitle: songs[0]?.title ?? null,
    });
    return c.html(html, 200, {
      "X-EdgeSonic-Share": id,
      "Cache-Control": "no-store",
    });
  }

  // ----- Byte-stream branch (audio clients, <audio> element) -----
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
  headers.set("X-EdgeSonic-Share", id);

  return new Response(result.body, { status: result.statusCode, headers });
});

// Exported for tests in 075 — pure render fn keeps unit testing trivial.
export const __internals = { escapeHtml, renderShareHtml };
