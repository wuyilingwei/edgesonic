// 106 — Subsonic 1.16.1 media library scanning endpoints, exposed at /rest/*.
//
// The actual scan logic lives in endpoints/storage/scan.ts (WebDAV + S3
// crawling, scan_jobs tracking, worker pool dispatch). This file is a thin
// router that mounts the exported handlers under the Subsonic-protocol paths
// /rest/startScan and /rest/getScanStatus so Subsonic clients (DSub "refresh
// library", Submariner, etc.) can trigger and poll scans.
//
// The /storage/scan/* paths stay registered for the web UI (Files.vue polls
// /storage/scan/status which returns the same XML shape).

import { Hono } from "hono";
import type { Context } from "hono";
import { permissionMiddleware } from "../../auth";
import { startScanHandler, getScanStatusHandler } from "../storage/scan";
import type { User } from "../../types/entities";

export const subsonicScanRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

function register(path: string, handler: (c: Context) => Promise<Response> | Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    subsonicScanRoutes.get(p, handler);
    subsonicScanRoutes.post(p, handler);
  }
}

// startScan requires manage_sources permission (same as the /storage path).
subsonicScanRoutes.get("/startScan", permissionMiddleware("manage_sources"), startScanHandler);
subsonicScanRoutes.get("/startScan.view", permissionMiddleware("manage_sources"), startScanHandler);
subsonicScanRoutes.post("/startScan", permissionMiddleware("manage_sources"), startScanHandler);
subsonicScanRoutes.post("/startScan.view", permissionMiddleware("manage_sources"), startScanHandler);

// getScanStatus is read-only; any authenticated user may poll it.
register("getScanStatus", getScanStatusHandler);