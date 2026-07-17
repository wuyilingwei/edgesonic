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

//
// Long-lived browser tabs run a stale bundle after we deploy fixes that touch
// the work-queue executor (078 error propagation, 080 reclaim). When the frontend
// keeps polling /edgesonic/work/poll with the old buggy code, attempts++ until
// the deterministic-ID rows hit failed permanently.
//
// The SPA records the version on first load, polls /edgesonic/version every 5
// minutes, and shows a "new version available, refresh now" banner when the
// returned version differs. The banner is intentionally non-blocking — users
// can dismiss it for the session.
//
// Auth: this endpoint is in NO_AUTH_PATHS (worker/src/auth.ts) so the polling
// fetch works even after the session expires. The payload only exposes the
// build version and build time.
import { Hono } from "hono";

export const versionRoutes = new Hono<{ Bindings: Env }>();

versionRoutes.get("/version", (c) => {
  const version = c.env.EDGESONIC_VERSION || "dev";
  return c.json({
    ok: true,
    version,
    buildTime: c.env.EDGESONIC_BUILD_TIME || null,
  });
});
