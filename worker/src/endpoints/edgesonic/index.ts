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
import { r2presignRoutes } from "./r2presign";
import { cloneRoutes } from "./clone";
import { statsRoutes } from "./stats";
import { syncRoutes } from "./sync";
import { lastfmRoutes } from "./lastfm";
import { artistScrapeRoutes } from "./artistScrape";

export const edgesonicRoutes = new Hono();

edgesonicRoutes.route("/", edgesonicAuthRoutes);
edgesonicRoutes.route("/", usersRoutes);
edgesonicRoutes.route("/", permissionsRoutes);
edgesonicRoutes.route("/", featuresRoutes);
edgesonicRoutes.route("/", transcodeRoutes);
edgesonicRoutes.route("/", workRoutes);
edgesonicRoutes.route("/", workUploadRoutes);
edgesonicRoutes.route("/", cfRoutes);
edgesonicRoutes.route("/", maintenanceRoutes);
edgesonicRoutes.route("/", versionRoutes);
edgesonicRoutes.route("/", r2presignRoutes);
edgesonicRoutes.route("/", cloneRoutes);
edgesonicRoutes.route("/", statsRoutes);
edgesonicRoutes.route("/", syncRoutes);
edgesonicRoutes.route("/", lastfmRoutes);
edgesonicRoutes.route("/", artistScrapeRoutes);
