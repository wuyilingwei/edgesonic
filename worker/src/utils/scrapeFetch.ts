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

// Shared scrape primitives. Both /tag/scrape (song search + lyrics) and
// /edgesonic/artistScrape (artist search + bio + cover) use these so we
// don't duplicate the UA / timeout code across endpoints.

export const SCRAPE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const SCRAPE_FETCH_TIMEOUT_MS = 8000;

// Fetch with an abort timer + a real-browser UA. Errors bubble up as the
// underlying fetch failure so callers can wrap them with upstream context.
export async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": SCRAPE_UA, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}