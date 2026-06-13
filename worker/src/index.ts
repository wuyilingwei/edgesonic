import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { registerRoutes } from "./router";
import { formPostMiddleware } from "./middleware/form_post";
import { refreshAllChannels } from "./utils/podcastSync";
import { webLoginRoutes } from "./endpoints/edgesonic/auth";
import { sharePublicRoutes } from "./endpoints/share_public";

// 049 — Re-export Sandbox class so the Cloudflare runtime can instantiate the
// Durable Object backing SandboxTranscodeEngine. This export must exist even
// when the engine is not in use (containers binding is declared in wrangler.toml).
export { Sandbox } from "@cloudflare/sandbox";

const app = new Hono();

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
  const isSubsonic = c.req.url.includes("/rest/");
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
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshAllChannels(env.DB).catch((e) => {
        console.error("scheduled refreshAllChannels failed:", e);
      }),
    );
  },
};
