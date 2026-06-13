// 055 — EdgeSonic private management bucket. Mounted at /edgesonic/* by
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

export const edgesonicRoutes = new Hono();

edgesonicRoutes.route("/", edgesonicAuthRoutes);
edgesonicRoutes.route("/", usersRoutes);
edgesonicRoutes.route("/", permissionsRoutes);
edgesonicRoutes.route("/", featuresRoutes);
edgesonicRoutes.route("/", transcodeRoutes);
