//
// Long-lived browser tabs run a stale bundle after we deploy fixes that touch
// the work-queue executor (078 error propagation, 080 reclaim). When the frontend
// keeps polling /edgesonic/work/poll with the old buggy code, attempts++ until
// the deterministic-ID rows hit failed permanently.
//
// The SPA records the version on first load, polls /edgesonic/version every 5
// minutes, and shows a "new version available, refresh now" banner when the
// returned version differs. The banner is intentionally non-blocking — users
// can dismiss it for the session.
//
// Auth: this endpoint is in NO_AUTH_PATHS (worker/src/auth.ts) so the polling
// fetch works even after the session expires. The payload only exposes the
// build version and start time, which is non-sensitive information that any
// curl probe could already infer from response timing.
import { Hono } from "hono";

const EDGESONIC_VERSION = "1.0.0";

const STARTED_AT = new Date().toISOString();

export const versionRoutes = new Hono<{ Bindings: Env }>();

versionRoutes.get("/version", (c) => {
  const version = c.env.WORKER_VERSION || "0";
  return c.json({
    ok: true,
    version,
    edgesonicVersion: EDGESONIC_VERSION,
    buildTime: STARTED_AT,
    startedAt: STARTED_AT,
  });
});
