import { Hono } from "hono";
import { subsonicOK } from "../../utils/xml";

export const pingRoutes = new Hono();

pingRoutes.get("/ping", (c) => {
  return c.text(subsonicOK({}), {
    headers: { "Content-Type": "application/xml; charset=UTF-8" },
  });
});

pingRoutes.get("/getLicense", (c) => {
  return c.text(
    subsonicOK({
      license: {
        _attributes: { valid: "true", email: "self-hosted@local", licenseExpires: "2099-12-31T00:00:00Z" },
      },
    }),
    { headers: { "Content-Type": "application/xml; charset=UTF-8" } }
  );
});
