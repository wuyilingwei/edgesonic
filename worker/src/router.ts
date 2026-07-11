//   /rest/*     Subsonic 1.16.1 + OpenSubsonic protocol
//   /tag/*        Tag management (web-session, edit_tags etc.)
//   /storage/*  Storage management (web-session, manage_sources/files)
//  /edgesonic/* EdgeSonic private (web-session, per-endpoint perms)
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
