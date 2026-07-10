import { Hono } from "hono";
import { authMiddleware, subsonicError } from "./auth";
import { registerRoutes } from "./router";
import { formPostMiddleware } from "./middleware/form_post";
import { formatMiddleware, xmlToJson } from "./middleware/format";
import { crossOriginIsolationMiddleware } from "./middleware/cross_origin_isolation";
import { refreshAllChannels } from "./utils/podcastSync";
import { maybeRunScheduledScan } from "./utils/scheduledScan";
import { reclaimStaleWork } from "./utils/workReclaim";
import { maybeRunMetadataRecheck } from "./utils/metadataRecheck";
import { maybeRunLrcBackfill } from "./utils/lrcBackfill";
import { webLoginRoutes } from "./endpoints/edgesonic/auth";
import { sharePublicRoutes } from "./endpoints/share_public";

// Durable Object backing SandboxTranscodeEngine. This export must exist even
// when the engine is not in use (containers binding is declared in wrangler.toml).
export { Sandbox } from "@cloudflare/sandbox";

const app = new Hono();

// ./middleware/cross_origin_isolation so the test suite can import it without
// dragging in the @cloudflare/sandbox container binding from this file's
// top-level re-export.
app.use("*", crossOriginIsolationMiddleware);

// has to run BEFORE any auth filter. Mounted on the bare app at
// /edgesonic/auth/login + /logout.
app.route("/", webLoginRoutes);

// anonymous visitors can press play on a share link without credentials.
app.route("/", sharePublicRoutes);

// OR application/x-www-form-urlencoded body. Merge any form body fields into
// the URL query BEFORE auth & route handlers run, so all existing
// `c.req.query()` / `c.req.queries()` call sites pick them up transparently.
// The middleware is still scoped to /rest/* because that's the only surface
// where Subsonic clients submit form-encoded bodies; the management buckets
// (/tag /storage /edgesonic) only accept JSON.
app.use("/rest/*", formPostMiddleware);

// occasionally request /rest/ping/ with a trailing slash. Hono's route
// matching is strict on trailing slashes, so /rest/ping/ would miss the
// /rest/ping route and fall through to 401 (auth middleware) or 404.
// Normalize: strip a single trailing slash from /rest/* paths before any
// auth or route logic runs. Only strips the LAST slash (not path components).
app.use("/rest/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/") && url.pathname !== "/rest/") {
    url.pathname = url.pathname.replace(/\/$/, "");
    return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  }
  return next();
});

// trailing-slash normalizer (so a re-dispatched request converts exactly
// once) and BEFORE authMiddleware, so auth-failure XML envelopes are
// converted too — a JSON client must never receive an XML error body.
app.use("/rest/*", formatMiddleware);

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
  // the management buckets (/edgesonic /tag /storage) return JSON. Using
  // pathname (not c.req.url) so a query string containing "/rest/" can't
  // trick a management error into rendering as XML.
  const isSubsonic = new URL(c.req.url).pathname.startsWith("/rest/");
  if (isSubsonic) {
    // rejects before it can transform), so honor f=json/jsonp here directly.
    const xml = subsonicError(0, err.message);
    const format = (c.req.query("f") || "xml").toLowerCase();
    if (format === "json" || format === "jsonp") {
      const json = JSON.stringify(xmlToJson(xml));
      return format === "jsonp"
        ? c.text(`${c.req.query("callback") || "cb"}(${json});`, 200, {
            "Content-Type": "application/javascript; charset=UTF-8",
          })
        : c.text(json, 200, { "Content-Type": "application/json; charset=UTF-8" });
    }
    return c.text(xml, 200, { "Content-Type": "application/xml; charset=UTF-8" });
  }
  return c.json({ ok: false, error: err.message }, 500);
});

// expression lives in wrangler.toml; this handler is what the Cloudflare
// runtime invokes for each tick. We use ctx.waitUntil so any failures inside
// refreshAllChannels (network blips, parse errors) don't crash the worker —
// per-channel errors are recorded into the channel row instead.
//
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
    // that went offline mid-task doesn't lock the row forever.
    ctx.waitUntil(
      reclaimStaleWork(env).catch((e) => {
        console.error("scheduled reclaimStaleWork failed:", e);
      }),
    );
    // worker's embedded parser couldn't read (other formats) or that are
    // missing lyrics/disc despite the album already having a cover.
    ctx.waitUntil(
      maybeRunMetadataRecheck(env, ctx).catch((e) => {
        console.error("scheduled maybeRunMetadataRecheck failed:", e);
      }),
    );
    // 113 — batch-scan song_masters still missing lyrics for a sibling .lrc
    // file. Independent of maybeRunMetadataRecheck: this never touches
    // work_queue, it reads directly from R2/WebDAV and writes D1 in place.
    ctx.waitUntil(
      maybeRunLrcBackfill(env, ctx).catch((e) => {
        console.error("scheduled maybeRunLrcBackfill failed:", e);
      }),
    );
  },
};
