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
import { workRoutes } from "./work";
import { workUploadRoutes } from "./work_upload";
import { cfRoutes } from "./cf";
import { maintenanceRoutes } from "./maintenance";
import { versionRoutes } from "./version";
import { r2presignRoutes } from "./r2presign";
import { cloneRoutes } from "./clone";
import { statsRoutes } from "./stats";

export const edgesonicRoutes = new Hono();

edgesonicRoutes.route("/", edgesonicAuthRoutes);
edgesonicRoutes.route("/", usersRoutes);
edgesonicRoutes.route("/", permissionsRoutes);
edgesonicRoutes.route("/", featuresRoutes);
edgesonicRoutes.route("/", transcodeRoutes);
edgesonicRoutes.route("/", workRoutes);
edgesonicRoutes.route("/", workUploadRoutes);
edgesonicRoutes.route("/", cfRoutes);
edgesonicRoutes.route("/", maintenanceRoutes);
edgesonicRoutes.route("/", versionRoutes);
edgesonicRoutes.route("/", r2presignRoutes);
edgesonicRoutes.route("/", cloneRoutes);
edgesonicRoutes.route("/", statsRoutes);
