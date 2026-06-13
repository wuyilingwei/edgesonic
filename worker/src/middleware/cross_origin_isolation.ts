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

// 065 — Cross-Origin Isolation response middleware.
//
// To unlock SharedArrayBuffer (required for ffmpeg.wasm multi-threading in
// the browser work pool) we have to flip `crossOriginIsolated = true` in every
// EdgeSonic origin tab. That demands three headers on the document and every
// resource the page loads from the same origin:
//   Cross-Origin-Opener-Policy:   same-origin       (isolates the BrowsingContext)
//   Cross-Origin-Embedder-Policy: require-corp      (every subresource needs a CORP grant)
//   Cross-Origin-Resource-Policy: same-origin       (default grant: only embeddable by same-origin pages)
//
// All EdgeSonic traffic is same-origin to the SPA, so a same-origin CORP keeps
// covers / streams / shares working without exposing them to cross-origin
// embedders. The feature is gated by feature_strings.enable_cross_origin_isolation
// — flip to '0' to roll back without redeploying. Handlers may set their own
// CORP (e.g. `cross-origin`) before this middleware runs; we only fill the
// default when the header is absent.
//
// Lives in its own file (instead of inline in index.ts) so the test suite can
// import it without dragging in the @cloudflare/sandbox container binding from
// index.ts's top-level re-export.

import { getFeatureString } from "../utils/features";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoLikeContext = { env: any; res: { headers: Headers } };
type Next = () => Promise<void>;

export const crossOriginIsolationMiddleware = async (
  c: HonoLikeContext,
  next: Next,
): Promise<void> => {
  await next();
  const env = c.env as Env;
  // Best-effort: if features util is unreachable (e.g. during D1 outage) we
  // skip stamping rather than 500 the entire response. Default is ON in the
  // 0022 migration so first-tick after deploy already has headers.
  let enabled = true;
  try {
    const value = await getFeatureString(env, "enable_cross_origin_isolation", "1");
    enabled = value !== "0";
  } catch { enabled = true; }
  if (!enabled) return;
  c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  if (!c.res.headers.has("Cross-Origin-Resource-Policy")) {
    c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
};
