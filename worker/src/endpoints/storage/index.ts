// endpoints require a web-session credential (enforced at auth.ts prefix level).
import { Hono } from "hono";
import { sourcesRoutes } from "./sources";
import { filesRoutes } from "./files";
import { browseRoutes } from "./browse";
import { scanRoutes } from "./scan";

export const storageRoutes = new Hono();

storageRoutes.route("/", sourcesRoutes);
storageRoutes.route("/", filesRoutes);
storageRoutes.route("/", browseRoutes);
storageRoutes.route("/", scanRoutes);
