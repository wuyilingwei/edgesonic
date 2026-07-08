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
// 052 — browser worker pool (poll / submit / heartbeat / dispatch / status / cancel)
edgesonicRoutes.route("/", workRoutes);
// 053 — browser-pool transcode upload (binary body, HMAC-signed token)
edgesonicRoutes.route("/", workUploadRoutes);
// 054 — Cloudflare API integration (token / cron / analytics)
edgesonicRoutes.route("/", cfRoutes);
// 078 — operational maintenance tools (cleanup-duplicate-covers, ...)
edgesonicRoutes.route("/", maintenanceRoutes);
// 081 — public version endpoint (no auth, SPA freshness detection)
edgesonicRoutes.route("/", versionRoutes);
// 091 — R2 presigned URL status (super-admin Dashboard hint)
edgesonicRoutes.route("/", r2presignRoutes);
// 094 — Subsonic server clone write endpoints (super-admin only, browser-driven)
edgesonicRoutes.route("/", cloneRoutes);
// 101 — storage stats + R2 cost estimation
edgesonicRoutes.route("/", statsRoutes);
