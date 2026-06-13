// 035 — OpenSubsonic protocol declaration.
//
// Routes:
//   - GET/POST /rest/getOpenSubsonicExtensions  (no auth — declared in auth.ts NO_AUTH_PATHS)
//   - GET/POST /rest/tokenInfo                  (any auth → echoes current user)
//
// Each is also exposed at `.view` so native Subsonic clients (Symfonium, DSub,
// Navidrome web, etc.) hit them. POST registrations satisfy our self-declared
// `formPost` extension.
//
// We ONLY advertise extensions EdgeSonic actually implements:
//   * apiKeyAuthentication v1 — auth.ts supports `?apiKey=...` lookup via KV
//   * tokenInfo v1            — this file
//   * formPost v1             — all mutating Subsonic endpoints accept POST
//
// NOT advertised (kept honest):
//   * songLyrics       — 036
//   * transcodeOffset  — 036
//   * indexBasedQueue  — no client implementation yet

import { Hono } from "hono";
import { subsonicOK } from "../../utils/xml";
import type { User } from "../../types/entities";

export const openSubsonicRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;

// ---------------------------------------------------------------------------
// getOpenSubsonicExtensions
// ---------------------------------------------------------------------------
// Spec: returns an `openSubsonicExtensions` element whose children are one
// `<openSubsonicExtensions name="..." versions="[1,2]"/>` per extension.
// Both Subsonic-XML and most JSON clients accept this exact shape.

const EXTENSIONS: Array<{ name: string; versions: number[] }> = [
  { name: "apiKeyAuthentication", versions: [1] },
  { name: "tokenInfo", versions: [1] },
  { name: "formPost", versions: [1] },
];

const extensionsHandler = (c: import("hono").Context) => {
  return c.text(
    subsonicOK({
      openSubsonicExtensions: EXTENSIONS.map((ext) => ({
        _attributes: {
          name: ext.name,
          // Versions emit as JSON-style "[1]" — what real OpenSubsonic servers
          // (Navidrome, Gonic) do; clients parse this as a typed array.
          versions: JSON.stringify(ext.versions),
        },
      })),
    }),
    200, XML,
  );
};

openSubsonicRoutes.get("/getOpenSubsonicExtensions", extensionsHandler);
openSubsonicRoutes.get("/getOpenSubsonicExtensions.view", extensionsHandler);
openSubsonicRoutes.post("/getOpenSubsonicExtensions", extensionsHandler);
openSubsonicRoutes.post("/getOpenSubsonicExtensions.view", extensionsHandler);

// ---------------------------------------------------------------------------
// tokenInfo
// ---------------------------------------------------------------------------
// Spec (extension): returns the authenticated user's basic info.
// Reference servers emit only `<tokenInfo username="..."/>`; we additionally
// include level + enabled permission names so the Web client can short-circuit
// permission-aware UI without a follow-up call.

const tokenInfoHandler = async (c: import("hono").Context) => {
  const user = c.get("user") as User;

  // Pull enabled permissions for this user's level (1 row per permission).
  const db = (c.env as Env).DB;
  const rows = await db
    .prepare(
      "SELECT permission FROM user_permissions WHERE level = ? AND enabled = 1 ORDER BY permission ASC"
    )
    .bind(user.level)
    .all<{ permission: string }>();
  const perms = rows.results.map((r) => r.permission);

  return c.text(
    subsonicOK({
      tokenInfo: {
        _attributes: {
          username: user.username,
          // OpenSubsonic spec stops at username. EdgeSonic enriches:
          level: String(user.level),
        },
        permission: perms.map((name) => ({ _attributes: { name } })),
      },
    }),
    200, XML,
  );
};

openSubsonicRoutes.get("/tokenInfo", tokenInfoHandler);
openSubsonicRoutes.get("/tokenInfo.view", tokenInfoHandler);
openSubsonicRoutes.post("/tokenInfo", tokenInfoHandler);
openSubsonicRoutes.post("/tokenInfo.view", tokenInfoHandler);
