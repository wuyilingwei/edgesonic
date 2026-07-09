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

// requires a web-session credential (auth.ts prefix check) plus the relevant
// permission (edit_tags / manage_sources / manage_files).
import { Hono } from "hono";
import { tagReadRoutes } from "./read";
import { tagEditRoutes } from "./write";
import { tidyFolderRoutes } from "./tidy";
import { scrapeRoutes } from "./scrape";
import { metadataRoutes } from "./submit";

export const tagRoutes = new Hono();

tagRoutes.route("/", tagReadRoutes);
tagRoutes.route("/", tagEditRoutes);
tagRoutes.route("/", tidyFolderRoutes);
tagRoutes.route("/", scrapeRoutes);
tagRoutes.route("/", metadataRoutes);
