import { Hono } from "hono";
import { pingRoutes } from "./endpoints/ping";
import { browsingRoutes } from "./endpoints/browsing";
import { searchRoutes } from "./endpoints/searching";
import { mediaRoutes } from "./endpoints/media";
import { adminRoutes } from "./endpoints/admin";

export function registerRoutes(app: Hono) {
  app.route("/", pingRoutes);
  app.route("/", browsingRoutes);
  app.route("/", searchRoutes);
  app.route("/", mediaRoutes);
  app.route("/", adminRoutes);
}
