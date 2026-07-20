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

import type { Context } from "hono";

// `private` is mandatory, never `public`: /rest/* URLs carry no user identity
// (the session cookie is the credential), so a cache keyed on the URL alone
// would let one user's library be served to another.
export const COVER_MAX_AGE_SEC = 86400;
export const AUDIO_MAX_AGE_SEC = 3600;

export function applyPrivateCache(headers: Headers, maxAgeSec: number, etag?: string | null, immutable = false): void {
  headers.set("Cache-Control", `private, max-age=${maxAgeSec}${immutable ? ", immutable" : ""}`);
  if (etag) headers.set("ETag", etag);
}

/** True when the client's If-None-Match already matches, so a 304 will do. */
export function etagMatches(c: Context, etag?: string | null): boolean {
  if (!etag) return false;
  const header = c.req.header("If-None-Match");
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === etag);
}

/**
 * Validator for a stored audio instance. Tag write-back updates both size and
 * updated_at, so a rewritten file always yields a new tag.
 */
export function instanceEtag(instance: { id: string; size: number | null; updated_at: number }): string {
  return `"${instance.id}-${instance.size ?? 0}-${instance.updated_at}"`;
}
