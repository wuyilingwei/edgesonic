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

import { Hono } from "hono";
import { pingRoutes } from "./endpoints/ping";
import { browsingRoutes } from "./endpoints/browsing";
import { searchRoutes } from "./endpoints/searching";
import { mediaRoutes } from "./endpoints/media";
import { adminRoutes } from "./endpoints/admin";
import { filesRoutes } from "./endpoints/files";
import { featuresRoutes } from "./endpoints/features";
import { scanRoutes } from "./endpoints/scan";
import { fileBrowseRoutes } from "./endpoints/filebrowse";
import { tagEditRoutes } from "./endpoints/tagedit";
import { playlistsRoutes } from "./endpoints/playlists";
import { bookmarksRoutes } from "./endpoints/bookmarks";
import { annotationRoutes } from "./endpoints/annotation";
import { transcodeRoutes } from "./endpoints/transcode";

export function registerRoutes(app: Hono) {
  app.route("/", pingRoutes);
  app.route("/", browsingRoutes);
  app.route("/", searchRoutes);
  app.route("/", mediaRoutes);
  app.route("/", adminRoutes);
  app.route("/", filesRoutes);
  app.route("/", featuresRoutes);
  app.route("/", scanRoutes);
  app.route("/", fileBrowseRoutes);
  app.route("/", tagEditRoutes);
  app.route("/", playlistsRoutes);
  app.route("/", bookmarksRoutes);
  app.route("/", annotationRoutes);
  app.route("/", transcodeRoutes);
}
