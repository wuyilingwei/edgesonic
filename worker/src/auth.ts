import { createMiddleware } from "hono/factory";
import { md5 } from "./utils/md5";
import { createQueries } from "./db/queries";
import type { User } from "./types/entities";

const NO_AUTH_PATHS = new Set([
  "/rest/ping",
  "/rest/getLicense",
  "/rest/getOpenSubsonicExtensions",
]);

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { user: User };
}>(async (c, next) => {
  const path = new URL(c.req.url).pathname;

  if (NO_AUTH_PATHS.has(path)) {
    return next();
  }

  const q = c.req.query();
  const username = q.u;
  const token = q.t;
  const salt = q.s;
  const apiKey = q.apiKey;
  const db = c.env.DB;
  const kv = c.env.KV;

  if (!username) {
    return c.text(subsonicError(40, "Missing username"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  const queries = createQueries(db);
  const user = await queries.getUser(username);

  if (!user) {
    return c.text(subsonicError(40, "Wrong username or password"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  if (apiKey) {
    const storedUser = await kv.get(`apikey:${apiKey}`);
    if (storedUser !== username) {
      return c.text(subsonicError(40, "Wrong username or password"), 401, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
  } else if (token && salt) {
    const expected = md5(user.password + salt);
    if (expected !== token) {
      return c.text(subsonicError(40, "Wrong username or password"), 401, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }
  } else {
    return c.text(subsonicError(40, "Missing authentication"), 401, {
      "Content-Type": "application/xml; charset=UTF-8",
    });
  }

  c.set("user", user);
  return next();
});

export const permissionMiddleware = (requiredPermission: string) =>
  createMiddleware<{
    Bindings: Env;
    Variables: { user: User };
  }>(async (c, next) => {
    const user = c.get("user");
    const db = c.env.DB;

    const perm = await db
      .prepare(
        "SELECT * FROM user_permissions WHERE level = ? AND permission = ? AND enabled = 1"
      )
      .bind(user.level, requiredPermission)
      .first<{ max_rph: number }>();

    if (!perm) {
      return c.text(subsonicError(50, "Not authorized"), 403, {
        "Content-Type": "application/xml; charset=UTF-8",
      });
    }

    if (perm.max_rph > 0) {
      const kv = c.env.KV;
      const rphKey = `rph:${user.username}:${requiredPermission}`;
      const count = parseInt((await kv.get(rphKey)) || "0", 10);
      if (count >= perm.max_rph) {
        return c.text(subsonicError(50, "Rate limit exceeded"), 429, {
          "Content-Type": "application/xml; charset=UTF-8",
        });
      }
      await kv.put(rphKey, String(count + 1), { expirationTtl: 3600 });
    }

    return next();
  });

export function subsonicError(code: number, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1">
  <error code="${code}" message="${escapeXml(message)}"/>
</subsonic-response>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
