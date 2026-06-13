// 081 — Public version endpoint for SPA freshness detection.
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

// The worker process boots when Cloudflare cold-starts the isolate. The value
// is captured once at module load; a redeploy creates a new isolate, so
// `startedAt` changes on every deploy in addition to `WORKER_VERSION`.
const STARTED_AT = new Date().toISOString();

export const versionRoutes = new Hono<{ Bindings: Env }>();

versionRoutes.get("/version", (c) => {
  // env.WORKER_VERSION is configured via wrangler.toml [vars]. Bump it before
  // each deploy (e.g. `wrangler deploy --var WORKER_VERSION:$(date +%s)`) so
  // that long-lived tabs detect the new bundle even if the isolate happens to
  // be warm-reused with the same startedAt.
  const version = c.env.WORKER_VERSION || "0";
  return c.json({
    ok: true,
    version,
    buildTime: STARTED_AT,
    startedAt: STARTED_AT,
  });
});
