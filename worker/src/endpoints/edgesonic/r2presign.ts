//
// Super-admin only. Reports whether the two R2 S3 secrets (R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY) are configured and the feature flag is on, so the
// Dashboard can surface a "stream speed may be limited" hint when presign is
// inactive. The R2 account id is read from CF_ACCOUNT_ID (already required by
// the 054 Cloudflare integration) — no separate R2_ACCOUNT_ID secret exists.
// Never echoes the secret values — only booleans.

import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { getFeatureString } from "../../utils/features";
import type { User } from "../../types/entities";

export const r2presignRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

r2presignRoutes.get("/r2presign/status", permissionMiddleware("manage_permissions"), async (c) => {
  const env = c.env as Env;
  const flag = await getFeatureString(env, "enable_r2_presign", "0");
  const secretsConfigured = Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CF_ACCOUNT_ID);
  return c.json({
    ok: true,
    enabled: flag === "1",
    secretsConfigured,
    active: flag === "1" && secretsConfigured,
  });
});