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

// 055 — Subsonic protocol surface aggregate. Every route declared here is
// mounted under `/rest/*` by router.ts and protected by the standard Subsonic
// auth (token+salt / apikey / guestToken). Adding a Subsonic endpoint? Drop
// the handler in a sibling file with a `/<name>` path, export the Hono router,
// and wire it up below.
import { Hono } from "hono";
import { pingRoutes } from "./ping";
import { browsingRoutes } from "./browsing";
import { searchRoutes } from "./searching";
import { mediaRoutes } from "./media";
import { annotationRoutes } from "./annotation";
import { playlistsRoutes } from "./playlists";
import { bookmarksRoutes } from "./bookmarks";
import { sharesRoutes } from "./shares";
import { radioRoutes } from "./radio";
import { podcastsRoutes } from "./podcasts";
import { infoRoutes } from "./info";
import { openSubsonicRoutes } from "./opensubsonic";
import { nowPlayingRoutes } from "./now_playing";
import { lyricsRoutes } from "./lyrics";
import { accountRoutes } from "./account";
import { downloadRoutes } from "./download";
import { subsonicUserRoutes } from "./users";
import { subsonicScanRoutes } from "./scan";

export const subsonicRoutes = new Hono();

subsonicRoutes.route("/", pingRoutes);
subsonicRoutes.route("/", browsingRoutes);
subsonicRoutes.route("/", searchRoutes);
subsonicRoutes.route("/", mediaRoutes);
subsonicRoutes.route("/", annotationRoutes);
subsonicRoutes.route("/", playlistsRoutes);
subsonicRoutes.route("/", bookmarksRoutes);
subsonicRoutes.route("/", sharesRoutes);
subsonicRoutes.route("/", radioRoutes);
subsonicRoutes.route("/", podcastsRoutes);
subsonicRoutes.route("/", infoRoutes);
subsonicRoutes.route("/", openSubsonicRoutes);
subsonicRoutes.route("/", nowPlayingRoutes);
subsonicRoutes.route("/", lyricsRoutes);
subsonicRoutes.route("/", accountRoutes);
subsonicRoutes.route("/", downloadRoutes);
subsonicRoutes.route("/", subsonicUserRoutes);
subsonicRoutes.route("/", subsonicScanRoutes);
