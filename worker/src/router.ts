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

//   /rest/*       Subsonic 1.16.1 + OpenSubsonic protocol
//   /tag/*        Tag management   (web-session, edit_tags etc.)
//   /storage/*    Storage management (web-session, manage_sources/files)
//   /edgesonic/*  EdgeSonic private (web-session, per-endpoint perms)
// plus the publicly accessible /share/:id route registered outside the auth
// middleware (see index.ts).
import { Hono } from "hono";
import { subsonicRoutes } from "./endpoints/subsonic";
import { tagRoutes } from "./endpoints/tag";
import { storageRoutes } from "./endpoints/storage";
import { edgesonicRoutes } from "./endpoints/edgesonic";

export function registerRoutes(app: Hono) {
  app.route("/rest", subsonicRoutes);
  app.route("/tag", tagRoutes);
  app.route("/storage", storageRoutes);
  app.route("/edgesonic", edgesonicRoutes);
}
