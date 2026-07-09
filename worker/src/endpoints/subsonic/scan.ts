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
