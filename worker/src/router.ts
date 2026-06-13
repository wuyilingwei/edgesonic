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
import { tidyFolderRoutes } from "./endpoints/tidyfolder";
import { playlistsRoutes } from "./endpoints/playlists";
import { bookmarksRoutes } from "./endpoints/bookmarks";
import { annotationRoutes } from "./endpoints/annotation";
import { transcodeRoutes } from "./endpoints/transcode";
import { scrapeRoutes } from "./endpoints/scrape";
import { metadataRoutes } from "./endpoints/metadata";

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
  app.route("/", tidyFolderRoutes);
  app.route("/", playlistsRoutes);
  app.route("/", bookmarksRoutes);
  app.route("/", annotationRoutes);
  app.route("/", transcodeRoutes);
  app.route("/", scrapeRoutes);
  app.route("/", metadataRoutes);
}
