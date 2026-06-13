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

// 055 — EdgeSonic private management bucket. Mounted at /edgesonic/* by
// router.ts. Web-session-only (enforced at auth.ts prefix level).
//
// NOTE: webLoginRoutes lives separately because it has to run BEFORE
// authMiddleware (it's the route that mints the session token). index.ts
// mounts that router directly on the app, outside this aggregate.
import { Hono } from "hono";
import { edgesonicAuthRoutes } from "./auth";
import { usersRoutes } from "./users";
import { permissionsRoutes } from "./permissions";
import { featuresRoutes } from "./features";
import { transcodeRoutes } from "./transcode";
import { workRoutes } from "./work";
import { workUploadRoutes } from "./work_upload";
import { cfRoutes } from "./cf";
import { maintenanceRoutes } from "./maintenance";
import { versionRoutes } from "./version";

export const edgesonicRoutes = new Hono();

edgesonicRoutes.route("/", edgesonicAuthRoutes);
edgesonicRoutes.route("/", usersRoutes);
edgesonicRoutes.route("/", permissionsRoutes);
edgesonicRoutes.route("/", featuresRoutes);
edgesonicRoutes.route("/", transcodeRoutes);
// 052 — browser worker pool (poll / submit / heartbeat / dispatch / status / cancel)
edgesonicRoutes.route("/", workRoutes);
// 053 — browser-pool transcode upload (binary body, HMAC-signed token)
edgesonicRoutes.route("/", workUploadRoutes);
// 054 — Cloudflare API integration (token / cron / analytics)
edgesonicRoutes.route("/", cfRoutes);
// 078 — operational maintenance tools (cleanup-duplicate-covers, ...)
edgesonicRoutes.route("/", maintenanceRoutes);
// 081 — public version endpoint (no auth, SPA freshness detection)
edgesonicRoutes.route("/", versionRoutes);
