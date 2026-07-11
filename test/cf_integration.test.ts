//
// Coverage:
//  1. callCfApi success / CF success=false / non-JSON branches
//  2. setToken validates against /accounts/{id} then PUTs both secrets,
//    with the request body shape the CF API expects
//  3. setToken returns 400 when accountId/token missing
//  4. setToken returns 400 when CF validation rejects the token
//  5. getStatus reflects env presence + tokenLast4 + accountId
//  6. testConn returns 400 with no env, 200 on success, 502 on failure
//  7. setCron PUTs the correct schedules body; rejects bad expressions
//  8. getAnalytics aggregates GraphQL buckets into requests/errors/cpuMs
//  9. getAnalytics returns { available: false } on GraphQL errors
//
// Run: npx tsx test/cf_integration.test.ts

import { Hono } from "hono";
import { cfRoutes, callCfApi } from "../worker/src/endpoints/edgesonic/cf";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type Env = unknown }

// ---------------------------------------------------------------------------
// Fetch mock. Each test installs a queue of expected (matcher, response)
// pairs; consumed in order. Anything unmatched throws so we never silently
// hit the real CF API.
// ---------------------------------------------------------------------------
interface FetchExpectation {
  match: (req: Request, url: string) => boolean;
  reply: (req: Request) => Response | Promise<Response>;
  // For assertions — captures the matched request for body inspection.
  capture?: { req?: Request; body?: unknown };
}

let expectations: FetchExpectation[] = [];
const realFetch = global.fetch;

function installMock() {
  expectations = [];
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request
      ? input
      : new Request(String(input), init);
    const url = req.url;
    for (let i = 0; i < expectations.length; i++) {
      const e = expectations[i];
      if (e.match(req, url)) {
        // Capture body for assertions before passing to reply (which may
        // consume req.body if we cloned without care).
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
// App builder — mounts cfRoutes with a super-admin context var.
// ---------------------------------------------------------------------------
// that reads user_permissions from c.env.DB. The harness injects a minimal D1
// stub that answers the one SELECT the middleware issues; rows seeded so that
// level=3 → enabled=1 and anything else → enabled=0 (matches the production
// default from migration 0024).
function makeApp(env: Record<string, string | undefined>, level = 3) {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbStub: any = {
    prepare(_q: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let boundArgs: any[] = [];
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bind(...args: any[]) { boundArgs = args; return this; },
        async first() {
          // permissionMiddleware: SELECT enabled, max_rph FROM user_permissions
          // WHERE level = ? AND permission = ?
          const callerLevel = boundArgs[0];
          return { enabled: callerLevel === 3 ? 1 : 0, max_rph: 0 };
        },
        async all() { return { results: [], success: true, meta: {} }; },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
    },
  };
  // Stitch DB into the env bag the cf.ts endpoints read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envWithDb: any = { ...env, DB: dbStub };
  app.use("*", async (c, next) => {
    // Hono `c.env` reads from c.req.raw, but for testing we attach directly.
    (c as unknown as { env: Record<string, unknown> }).env = envWithDb;
    c.set("user", { username: "tester", level });
    await next();
  });
  app.route("/edgesonic", cfRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// 1. callCfApi
// ---------------------------------------------------------------------------
async function run() {
  console.log("callCfApi:");
  {
    installMock();
    expectations.push({
      match: (_r, url) => url.includes("/accounts/test"),
      reply: () => jsonResp({ success: true, result: { id: "test", name: "Test Acc" } }),
    });
    const result = await callCfApi("tok-1", "/accounts/test");
    assert(typeof result === "object" && (result as { id?: string }).id === "test",
      "returns result on success=true");
    uninstallMock();
  }
  {
    installMock();
    expectations.push({
      match: () => true,
      reply: () => jsonResp({ success: false, errors: [{ message: "Token bad" }] }),
    });
    let threw = false;
    try { await callCfApi("tok-bad", "/accounts/x"); }
    catch (e) { threw = e instanceof Error && /Token bad/.test(e.message); }
    assert(threw, "throws with CF error message on success=false");
    uninstallMock();
  }
  {
    installMock();
    expectations.push({
      match: () => true,
      reply: () => new Response("not json", { status: 500 }),
    });
    let threw = false;
    try { await callCfApi("tok", "/x"); }
    catch (e) { threw = e instanceof Error && /non-JSON/.test(e.message); }
    assert(threw, "throws on non-JSON response");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 2+3. setToken happy path + missing fields
  // ---------------------------------------------------------------------------
  console.log("\nsetToken:");
  {
    installMock();
    const env: Record<string, string | undefined> = { CF_API_TOKEN: undefined, CF_ACCOUNT_ID: undefined };
    const app = makeApp(env);
    const validateCapture: { req?: Request; body?: unknown } = {};
    const sec1Capture: { req?: Request; body?: unknown } = {};
    const sec2Capture: { req?: Request; body?: unknown } = {};

    // 1) Validate against /accounts/{id}
    expectations.push({
      match: (r, url) => r.method === "GET" && url.endsWith("/accounts/acc-1"),
      reply: () => jsonResp({ success: true, result: { id: "acc-1", name: "Live" } }),
      capture: validateCapture,
    });
    // 2) PUT secret CF_API_TOKEN
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.includes("/workers/scripts/edgesonic/secrets"),
      reply: () => jsonResp({ success: true, result: {} }),
      capture: sec1Capture,
    });
    // 3) PUT secret CF_ACCOUNT_ID
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.includes("/workers/scripts/edgesonic/secrets"),
      reply: () => jsonResp({ success: true, result: {} }),
      capture: sec2Capture,
    });

    const r = await app.request("/edgesonic/cf/setToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acc-1", token: "new-token-XYZ1" }),
    });
    const body = await r.json() as { ok: boolean; tokenLast4?: string; accountId?: string };
    assert(r.status === 200, "200 OK on success");
    assert(body.ok === true, "ok=true");
    assert(body.tokenLast4 === "XYZ1", "tokenLast4 returned (last 4 chars only)");
    assert(body.accountId === "acc-1", "accountId echoed");

    const b1 = sec1Capture.body as { name?: string; text?: string; type?: string } | undefined;
    assert(b1?.name === "CF_API_TOKEN", "first PUT body name=CF_API_TOKEN");
    assert(b1?.text === "new-token-XYZ1", "first PUT body carries the new token text");
    assert(b1?.type === "secret_text", "first PUT body type=secret_text");

    const b2 = sec2Capture.body as { name?: string; text?: string; type?: string } | undefined;
    assert(b2?.name === "CF_ACCOUNT_ID", "second PUT body name=CF_ACCOUNT_ID");
    assert(b2?.text === "acc-1", "second PUT body carries accountId");
    uninstallMock();
  }

  // Missing token
  {
    installMock();
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/setToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "x" }),
    });
    assert(r.status === 400, "400 when token missing");
    uninstallMock();
  }
  // Missing accountId (no env fallback)
  {
    installMock();
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/setToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "abc" }),
    });
    assert(r.status === 400, "400 when accountId missing and no env fallback");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 4. CF rejects token during validation → 400
  // ---------------------------------------------------------------------------
  {
    installMock();
    expectations.push({
      match: () => true,
      reply: () => jsonResp({ success: false, errors: [{ message: "Invalid token" }] }),
    });
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/setToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acc-1", token: "bad" }),
    });
    const body = await r.json() as { ok: boolean; error?: string };
    assert(r.status === 400, "400 when CF rejects validation");
    assert(/Invalid token/.test(body.error || ""), "error message surfaces CF error");
    uninstallMock();
  }

  // Non-super forbidden
  {
    installMock();
    const app = makeApp({}, /* level */ 2);
    const r = await app.request("/edgesonic/cf/setToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "x", token: "y" }),
    });
    assert(r.status === 403, "403 for level<3");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 5. getStatus
  // ---------------------------------------------------------------------------
  console.log("\ngetStatus:");
  {
    installMock();
    const app1 = makeApp({});
    const r1 = await app1.request("/edgesonic/cf/getStatus");
    const b1 = await r1.json() as { configured: boolean; tokenLast4: string; accountId: string };
    assert(b1.configured === false, "configured=false when env empty");
    assert(b1.tokenLast4 === "", "no tokenLast4 when env empty");

    const app2 = makeApp({ CF_API_TOKEN: "abcdef-LIVE-7890", CF_ACCOUNT_ID: "acc-9" });
    const r2 = await app2.request("/edgesonic/cf/getStatus");
    const b2 = await r2.json() as { configured: boolean; tokenLast4: string; accountId: string };
    assert(b2.configured === true, "configured=true when env set");
    assert(b2.tokenLast4 === "7890", "tokenLast4 takes last 4 chars");
    assert(b2.accountId === "acc-9", "accountId echoed from env");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 6. testConn
  // ---------------------------------------------------------------------------
  console.log("\ntestConn:");
  {
    installMock();
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/testConn");
    assert(r.status === 400, "400 when env empty");
    uninstallMock();
  }
  {
    installMock();
    expectations.push({
      match: (_r, url) => url.endsWith("/accounts/acc-2"),
      reply: () => jsonResp({ success: true, result: { id: "acc-2", name: "Prod" } }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-2" });
    const r = await app.request("/edgesonic/cf/testConn");
    const body = await r.json() as { ok: boolean; accountName?: string };
    assert(r.status === 200 && body.ok === true, "200 OK on success");
    assert(body.accountName === "Prod", "accountName surfaces");
    uninstallMock();
  }
  {
    installMock();
    expectations.push({
      match: () => true,
      reply: () => jsonResp({ success: false, errors: [{ message: "auth fail" }] }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-2" });
    const r = await app.request("/edgesonic/cf/testConn");
    assert(r.status === 502, "502 when CF rejects");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 7. setCron
  // ---------------------------------------------------------------------------
  console.log("\nsetCron:");
  {
    installMock();
    const capture: { req?: Request; body?: unknown } = {};
    expectations.push({
      match: (r, url) => r.method === "PUT" && url.includes("/workers/scripts/edgesonic/schedules"),
      reply: () => jsonResp({
        success: true,
        result: [{ cron: "0 * * * *", created_on: "x", modified_on: "x" }],
      }),
      capture,
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-3" });
    const r = await app.request("/edgesonic/cf/setCron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crons: ["0 * * * *"] }),
    });
    const body = await r.json() as { ok: boolean; schedules: unknown };
    assert(r.status === 200 && body.ok === true, "200 OK on success");
    const sent = capture.body as Array<{ cron: string }>;
    assert(Array.isArray(sent) && sent.length === 1 && sent[0].cron === "0 * * * *",
      "PUT body is [{cron:'0 * * * *'}]");
    uninstallMock();
  }
  // Bad cron expression → 400 (no CF call)
  {
    installMock();
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-3" });
    const r = await app.request("/edgesonic/cf/setCron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crons: ["not valid"] }),
    });
    assert(r.status === 400, "400 when cron lacks 5 fields");
    assert(expectations.length === 0, "no fetch hit CF for bad cron");
    uninstallMock();
  }
  // No env config → 400
  {
    installMock();
    const app = makeApp({});
    const r = await app.request("/edgesonic/cf/setCron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crons: ["0 * * * *"] }),
    });
    assert(r.status === 400, "400 when CF env not configured");
    uninstallMock();
  }

  // ---------------------------------------------------------------------------
  // 8. getAnalytics happy path
  // ---------------------------------------------------------------------------
  console.log("\ngetAnalytics:");
  {
    installMock();
    expectations.push({
      match: (r, url) => r.method === "POST" && url.endsWith("/graphql"),
      reply: () => jsonResp({
        data: {
          viewer: {
            accounts: [{
              workersInvocationsAdaptive: [
                { sum: { requests: 100, errors: 3 }, quantiles: { cpuTimeP50: 2500, cpuTimeP99: 5000 } },
                { sum: { requests: 50, errors: 1 }, quantiles: { cpuTimeP50: 3500, cpuTimeP99: 7000 } },
              ],
            }],
          },
        },
      }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-4" });
    const r = await app.request("/edgesonic/cf/getAnalytics");
    const body = await r.json() as {
      available: boolean;
      requests: number;
      errors: number;
      errorRate: number;
      cpuMs: number;
    };
    assert(body.available === true, "available=true on success");
    assert(body.requests === 150, "sums request counts across buckets");
    assert(body.errors === 4, "sums errors across buckets");
    assert(Math.abs(body.errorRate - 4 / 150) < 1e-9, "errorRate = errors/requests");
    // (2500 + 3500) / 2 / 1000 = 3.000 ms
    assert(body.cpuMs === 3, "cpuMs is the avg of CPU P50 (microseconds → ms)");
    uninstallMock();
  }
  // GraphQL error → available: false
  {
    installMock();
    expectations.push({
      match: (_r, url) => url.endsWith("/graphql"),
      reply: () => jsonResp({ errors: [{ message: "Not authorized" }] }),
    });
    const app = makeApp({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acc-4" });
    const r = await app.request("/edgesonic/cf/getAnalytics");
    const body = await r.json() as { available: boolean; error?: string };
    assert(r.status === 200, "200 even when GraphQL fails (UI-friendly)");
    assert(body.available === false, "available=false on GraphQL error");
    assert(/Not authorized/.test(body.error || ""), "error message surfaces");
    uninstallMock();
  }

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
