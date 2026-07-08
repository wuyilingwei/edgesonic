// 067 — /edgesonic/cf/ensureDefaultCron unit tests.
//
// Coverage:
//   1. Empty live schedules → PUT default, returns applied=true with the
//      CF-canonical result echoed in `schedules`.
//   2. Non-empty live schedules → NO PUT issued, returns applied=false with
//      the existing schedules echoed (admin's custom cadence preserved).
//   3. Missing CF_API_TOKEN / CF_ACCOUNT_ID → 400 with the same wording the
//      054 endpoints use, so the Settings UI can switch on the wording.
//   4. Non-super user (level < 3) → 403 (guard runs before any CF call).
//
// Mirrors the style of test/cf_integration.test.ts so the two suites share
// the fetch-mock harness shape exactly.
//
// Run: npx tsx test/cf_ensure_default_cron.test.ts

import { Hono } from "hono";
import { cfRoutes } from "../worker/src/endpoints/edgesonic/cf";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type Env = unknown }

// ---------------------------------------------------------------------------
// Fetch mock (copy of the one in cf_integration.test.ts — kept local so the
// suites can be invoked independently).
// ---------------------------------------------------------------------------
interface FetchExpectation {
  match: (req: Request, url: string) => boolean;
  reply: (req: Request) => Response | Promise<Response>;
  capture?: { req?: Request; body?: unknown };
}

let expectations: FetchExpectation[] = [];
let unexpectedCount = 0;
const realFetch = global.fetch;

function installMock() {
  expectations = [];
  unexpectedCount = 0;
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request
      ? input
      : new Request(String(input), init);
    const url = req.url;
    for (let i = 0; i < expectations.length; i++) {
      const e = expectations[i];
      if (e.match(req, url)) {
        if (e.capture) {
          e.capture.req = req.clone();
          try {
            e.capture.body = await req.clone().json();
          } catch { e.capture.body = undefined; }
        }
        expectations.splice(i, 1);
        return e.reply(req);
      }
    }
    unexpectedCount++;
    throw new Error(`Unexpected fetch: ${req.method} ${url}`);
  }) as typeof fetch;
}

function uninstallMock() {
  global.fetch = realFetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// App builder — mirrors the cf_integration.test.ts harness so the test
// surface (`/edgesonic/cf/...`) matches what router.ts produces in prod.
// ---------------------------------------------------------------------------
function makeApp(env: Record<string, string | undefined>, level = 3) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = env;
    c.set("user", { username: "rosmontis", level });
    await next();
  });
  app.route("/edgesonic", cfRoutes);
  return app;
}

const SCHEDULES_PATH = "/workers/scripts/edgesonic/schedules";

async function run() {
  console.log("ensureDefaultCron — empty schedules path:");
  {
    installMock();
    const putCapture: { req?: Request; body?: unknown } = {};

    // 1) GET schedules — returns empty list, simulating a fresh wrangler deploy.
    expectations.push({
      match: (r, url) => r.method === "GET" && url.endsWith(SCHEDULES_PATH),
      reply: () => jsonResp({ success: true, result: { schedules: [] } }),
    });
    // 2) PUT default schedule.
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES_PATH),
      reply: () => jsonResp({
        success: true,
        result: [{ cron: "0 */1 * * *", created_on: "2026-06-14T00:00:00Z", modified_on: "2026-06-14T00:00:00Z" }],
      }),
      capture: putCapture,
    });

    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-1" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean; applied: boolean; schedules: unknown };

    assert(r.status === 200, "200 OK");
    assert(body.ok === true, "ok=true");
    assert(body.applied === true, "applied=true when GET returns empty list");
    const sent = putCapture.body as Array<{ cron: string }>;
    assert(Array.isArray(sent) && sent.length === 1, "PUT body is single-element array");
    assert(sent[0].cron === "0 */1 * * *", "PUT body cron is the documented hourly default");
    const echo = body.schedules as Array<{ cron: string }>;
    assert(Array.isArray(echo) && echo[0].cron === "0 */1 * * *",
      "response.schedules echoes the CF PUT response");
    assert(expectations.length === 0, "both expected fetches were consumed");
    assert(unexpectedCount === 0, "no unexpected fetches");
    uninstallMock();
  }

  console.log("\nensureDefaultCron — non-empty schedules path:");
  {
    installMock();
    const putCapture: { req?: Request; body?: unknown } = {};

    // GET returns a custom cadence the admin already configured.
    expectations.push({
      match: (r, url) => r.method === "GET" && url.endsWith(SCHEDULES_PATH),
      reply: () => jsonResp({
        success: true,
        result: {
          schedules: [
            { cron: "*/15 * * * *", created_on: "2026-06-13T00:00:00Z", modified_on: "2026-06-13T00:00:00Z" },
          ],
        },
      }),
    });
    // Register a PUT matcher that, if hit, marks the test as failed by
    // capturing the body. The contract is "no PUT issued" so this should
    // never fire — we keep it registered as a tripwire.
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.endsWith(SCHEDULES_PATH),
      reply: () => jsonResp({ success: true, result: [] }),
      capture: putCapture,
    });

    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-2" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean; applied: boolean; schedules: Array<{ cron: string }> };

    assert(r.status === 200, "200 OK");
    assert(body.ok === true, "ok=true");
    assert(body.applied === false, "applied=false when admin already has custom cron");
    assert(Array.isArray(body.schedules) && body.schedules.length === 1,
      "schedules array preserved");
    assert(body.schedules[0].cron === "*/15 * * * *",
      "existing custom cron echoed verbatim");
    assert(putCapture.body === undefined, "no PUT fetch issued (tripwire untouched)");
    // The PUT tripwire is still in expectations; the GET should be consumed.
    assert(expectations.length === 1, "only PUT tripwire remains (GET consumed)");
    uninstallMock();
  }

  console.log("\nensureDefaultCron — missing CF env:");
  {
    installMock();
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean; error?: string };
    assert(r.status === 400, "400 when CF_API_TOKEN / CF_ACCOUNT_ID missing");
    assert(body.ok === false, "ok=false");
    assert(/not configured/i.test(body.error || ""),
      "error wording matches 054 convention ('not configured')");
    assert(unexpectedCount === 0, "no fetch made before env guard fired");
    uninstallMock();
  }
  // Only account ID missing — token alone is not enough.
  {
    installMock();
    const app = makeApp({ CF_API_TOKEN: "tok" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    assert(r.status === 400, "400 when only token set (accountId missing)");
    uninstallMock();
  }
  // Only token missing — account ID alone is not enough.
  {
    installMock();
    const app = makeApp({ CF_ACCOUNT_ID: "acc" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    assert(r.status === 400, "400 when only accountId set (token missing)");
    uninstallMock();
  }

  console.log("\nensureDefaultCron — auth guard:");
  {
    installMock();
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" }, /* level */ 2);
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean };
    assert(r.status === 403, "403 for level<3");
    assert(body.ok === false, "ok=false");
    assert(unexpectedCount === 0, "guard short-circuits before any CF call");
    uninstallMock();
  }

  console.log("\nensureDefaultCron — CF GET error surfaces as 502:");
  {
    installMock();
    expectations.push({
      match: (r) => r.method === "GET",
      reply: () => jsonResp({ success: false, errors: [{ message: "permission denied" }] }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean; error?: string };
    assert(r.status === 502, "502 when CF GET rejects");
    assert(body.ok === false, "ok=false");
    assert(/permission denied/i.test(body.error || ""),
      "CF error message bubbles up to the response");
    uninstallMock();
  }

  console.log("\nensureDefaultCron — CF PUT error surfaces as 502:");
  {
    installMock();
    expectations.push({
      match: (r) => r.method === "GET",
      reply: () => jsonResp({ success: true, result: { schedules: [] } }),
    });
    expectations.push({
      match: (r) => r.method === "PUT",
      reply: () => jsonResp({ success: false, errors: [{ message: "Workers Scripts:Edit required" }] }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc" });
    const r = await app.request("/edgesonic/cf/ensureDefaultCron");
    const body = await r.json() as { ok: boolean; error?: string };
    assert(r.status === 502, "502 when CF PUT rejects after empty GET");
    assert(/Workers Scripts:Edit/.test(body.error || ""),
      "scope error wording surfaces (helps admin diagnose token scopes)");
    uninstallMock();
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
