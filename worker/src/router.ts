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
}
