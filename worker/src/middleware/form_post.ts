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

// ============================================================================
// Task 047 — formPost OpenSubsonic extension.
//
// Real Subsonic clients (DSub, Symfonium, Navidrome web …) often POST with
// Content-Type: application/x-www-form-urlencoded for endpoints that mutate
// state (createPlaylist, scrobble, star with many ids). The Subsonic spec
// says servers SHOULD accept either query OR form params — we declare
// `formPost` in getOpenSubsonicExtensions, so we have to honour it on every
// /rest/* route.
//
// Implementation strategy:
//
//   * Only intercept POST + Content-Type starting with
//     `application/x-www-form-urlencoded`. JSON bodies (admin endpoints,
//     tagedit, etc.), raw streams (files/upload), and multipart (file
//     uploads) are pass-through.
//
//   * Read the body text once, parse with URLSearchParams, merge into the
//     URL's query string. Existing query params WIN — Subsonic clients that
//     send `?u=alice` + `id=sg-1` in the body should keep `u=alice` from
//     the URL.
//
//   * Replace the underlying Request on c.req so all subsequent handlers
//     see the merged URL via c.req.query(). The body is also replaced with
//     an empty string so downstream handlers that *do* call parseBody()
//     (playlists.ts, bookmarks.ts) still work — they fall back to the now-
//     visible query params via their `readField` helpers.
//
// We deliberately do NOT consume the body for any other content-type — JSON
// endpoints still read the raw body via c.req.json().
// ============================================================================

import { createMiddleware } from "hono/factory";

const FORM_CT = "application/x-www-form-urlencoded";

export const formPostMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (c.req.method !== "POST") return next();

  const contentType = (c.req.header("content-type") || "").toLowerCase();
  if (!contentType.startsWith(FORM_CT)) return next();

  // Read body text once. If the body is empty / unreadable, just continue.
  let bodyText = "";
  try {
    bodyText = await c.req.raw.text();
  } catch {
    return next();
  }
  if (!bodyText) return next();

  const formParams = new URLSearchParams(bodyText);
  if ([...formParams.keys()].length === 0) return next();

  // Merge form params into URL query, URL-side wins on key collision.
  const url = new URL(c.req.url);
  for (const [k, v] of formParams.entries()) {
    // append (not set): Subsonic supports repeated keys (id=a&id=b). If the
    // URL already had this key, both URL and form values become available
    // via c.req.queries(k) — single c.req.query(k) returns the first
    // (URL) match.
    if (url.searchParams.has(k)) {
      // URL wins for single-value reads; still append so getAll/queries sees
      // the union — preserves multi-value form fields combined with URL key.
      url.searchParams.append(k, v);
    } else {
      url.searchParams.append(k, v);
    }
  }

  // Build a replacement Request. Keep headers but drop content-type to avoid
  // accidental re-parsing downstream; keep the method POST so route matching
  // (which is method-sensitive) still hits the POST handler.
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-type");
  headers.delete("content-length");

  const newReq = new Request(url.toString(), {
    method: "POST",
    headers,
    // Body is intentionally null — we already consumed it. parseBody() on a
    // bodyless Request returns {} in Hono, which is the correct behaviour
    // since the data has been hoisted into the query.
    body: null,
  });

  // hono@4 HonoRequest exposes `raw` via getter; the field backing it is
  // private but assignable. Replace it and clear hono's internal query/body
  // caches so c.req.query() re-parses from the new URL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqAny = c.req as any;
  reqAny.raw = newReq;
  // The internal `bodyCache` and `queryIndex` caches must be reset so that
  // subsequent c.req.query() / parseBody() reads the new request.
  if (reqAny.bodyCache) reqAny.bodyCache = {};
  if (reqAny.queryIndex !== undefined) reqAny.queryIndex = undefined;

  return next();
});
