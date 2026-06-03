import { Hono } from "hono";
import { authMiddleware, webLoginRoutes } from "./auth";
import { registerRoutes } from "./router";

const app = new Hono();

// Web login routes (no Subsonic auth required)
app.route("/", webLoginRoutes);

// Subsonic API routes (authenticated)
app.use("/rest/*", authMiddleware);

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

export default app;
