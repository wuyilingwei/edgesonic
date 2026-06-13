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

import { Hono } from "hono";
import { authMiddleware, webLoginRoutes } from "./auth";
import { registerRoutes } from "./router";

// 049 — Re-export Sandbox class so the Cloudflare runtime can instantiate the
// Durable Object backing SandboxTranscodeEngine. This export must exist even
// when the engine is not in use (containers binding is declared in wrangler.toml).
export { Sandbox } from "@cloudflare/sandbox";

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
