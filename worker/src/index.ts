import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { registerRoutes } from "./router";
import { formPostMiddleware } from "./middleware/form_post";
import { crossOriginIsolationMiddleware } from "./middleware/cross_origin_isolation";
import { refreshAllChannels } from "./utils/podcastSync";
import { maybeRunScheduledScan } from "./utils/scheduledScan";
import { reclaimStaleWork } from "./utils/workReclaim";
import { webLoginRoutes } from "./endpoints/edgesonic/auth";
import { sharePublicRoutes } from "./endpoints/share_public";

// 049 — Re-export Sandbox class so the Cloudflare runtime can instantiate the
// Durable Object backing SandboxTranscodeEngine. This export must exist even
// when the engine is not in use (containers binding is declared in wrangler.toml).
export { Sandbox } from "@cloudflare/sandbox";

const app = new Hono();

// 065 — Cross-Origin Isolation response headers. Lives in
// ./middleware/cross_origin_isolation so the test suite can import it without
// dragging in the @cloudflare/sandbox container binding from this file's
// top-level re-export.
app.use("*", crossOriginIsolationMiddleware);

// 055 — Login bootstraps the very session token authMiddleware checks, so it
// has to run BEFORE any auth filter. Mounted on the bare app at
// /edgesonic/auth/login + /logout.
app.route("/", webLoginRoutes);

// 055 — Public share route (/share/:id) sits outside every auth gate so
// anonymous visitors can press play on a share link without credentials.
app.route("/", sharePublicRoutes);

// 047 — formPost: Subsonic clients may send parameters as either query string
// OR application/x-www-form-urlencoded body. Merge any form body fields into
// the URL query BEFORE auth & route handlers run, so all existing
// `c.req.query()` / `c.req.queries()` call sites pick them up transparently.
// The middleware is still scoped to /rest/* because that's the only surface
// where Subsonic clients submit form-encoded bodies; the management buckets
// (/tag /storage /edgesonic) only accept JSON.
app.use("/rest/*", formPostMiddleware);

// 055 — All four buckets share the same auth middleware. The path-prefix
// strategy inside authMiddleware picks the right policy:
//   /rest/*       → Subsonic token+salt / apiKey / guestToken
//   /tag /storage /edgesonic → web-session credential only
app.use("/rest/*", authMiddleware);
app.use("/tag/*", authMiddleware);
app.use("/storage/*", authMiddleware);
app.use("/edgesonic/*", authMiddleware);

registerRoutes(app);

app.onError((err, c) => {
  console.error(err);
  // 055 — Match authMiddleware's format policy: /rest/* returns Subsonic XML,
  // the management buckets (/edgesonic /tag /storage) return JSON. Using
  // pathname (not c.req.url) so a query string containing "/rest/" can't
  // trick a management error into rendering as XML.
  const isSubsonic = new URL(c.req.url).pathname.startsWith("/rest/");
  if (isSubsonic) {
    return c.text(
      `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1">
  <error code="0" message="${err.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"/>
</subsonic-response>`,
      { headers: { "Content-Type": "application/xml; charset=UTF-8" } }
    );
  }
  return c.json({ ok: false, error: err.message }, 500);
});

// 046 — Cron Trigger: refresh every podcast RSS feed hourly. The cron
// expression lives in wrangler.toml; this handler is what the Cloudflare
// runtime invokes for each tick. We use ctx.waitUntil so any failures inside
// refreshAllChannels (network blips, parse errors) don't crash the worker —
// per-channel errors are recorded into the channel row instead.
//
// 051 — Same tick also drives WebDAV auto-scan. maybeRunScheduledScan reads
// scan_interval_hours + cron:last_scan_ts to decide whether to dispatch a new
// asyncScanSource per enabled source. Independent ctx.waitUntil() calls let
// either subsystem fail without blocking the other.
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshAllChannels(env.DB).catch((e) => {
        console.error("scheduled refreshAllChannels failed:", e);
      }),
    );
    ctx.waitUntil(
      maybeRunScheduledScan(env, ctx).catch((e) => {
        console.error("scheduled maybeRunScheduledScan failed:", e);
      }),
    );
    // 052 — sweep stale browser worker claims back into the queue so a tab
    // that went offline mid-task doesn't lock the row forever.
    ctx.waitUntil(
      reclaimStaleWork(env).catch((e) => {
        console.error("scheduled reclaimStaleWork failed:", e);
      }),
    );
  },
};
