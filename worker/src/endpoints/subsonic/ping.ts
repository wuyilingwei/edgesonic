import { Hono } from "hono";
import type { Context } from "hono";
import { subsonicOK } from "../../utils/xml";

export const pingRoutes = new Hono();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

const pingHandler = (c: Context) => c.text(subsonicOK({}), 200, XML);

const getLicenseHandler = (c: Context) =>
  c.text(
    subsonicOK({
      license: {
        _attributes: { valid: "true", email: "self-hosted@local", licenseExpires: "2099-12-31T00:00:00Z" },
      },
    }),
    200, XML,
  );

function register(path: string, handler: (c: Context) => Response) {
  for (const p of [`/${path}`, `/${path}.view`]) {
    pingRoutes.get(p, handler);
    pingRoutes.post(p, handler);
  }
}

register("ping", pingHandler);
register("getLicense", getLicenseHandler);
