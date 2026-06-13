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

// 054 — Cloudflare API integration.
//
// All endpoints live under /edgesonic/cf/* (web-session-only via the
// /edgesonic prefix in auth.ts). Authorisation:
//
//   POST /edgesonic/cf/setToken      — level=3
//   GET  /edgesonic/cf/getStatus     — level=3
//   GET  /edgesonic/cf/testConn      — level=3
//   POST /edgesonic/cf/setCron       — level=3
//   GET  /edgesonic/cf/getCron       — level=3
//   GET  /edgesonic/cf/getAnalytics  — level=3
//
// Design notes (per Rosmontis 054 brief):
//   - Token storage is via Workers Secrets, NOT D1/KV encryption. We push the
//     secret with CF API (PUT /accounts/{id}/workers/scripts/{name}/secrets).
//   - "Fast update": admin POSTs new token here; the worker uses the *currently
//     loaded* env.CF_API_TOKEN (the old one) — or the token in the request
//     body when env is empty (bootstrap path) — to write the new secret. Next
//     request's env.CF_API_TOKEN reflects the new value, no redeploy needed.
//   - Cron schedules are managed dynamically too — wrangler.toml's `0 */1 * * *`
//     is a static fallback. The Settings UI overrides it via setCron.
//   - getAnalytics uses the Cloudflare GraphQL Analytics API for 24h rollups.
//     We swallow GraphQL errors into a `{ available: false, error }` shape so
//     the UI never crashes when the token lacks Account Analytics:Read.

import { Hono } from "hono";
import type { User } from "../../types/entities";

export const cfRoutes = new Hono<{
  Bindings: Env;
  Variables: { user: User };
}>();

// Script name must match wrangler.toml `name = "edgesonic"`. We hard-code
// rather than reading from env so a misconfigured deployment can't push a
// secret into the wrong Worker.
const SCRIPT_NAME = "edgesonic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Guard: every endpoint in this file requires level=3. We don't use
// permissionMiddleware because the 054 brief specifies level-only access
// (no per-permission row in user_permissions).
function requireSuper(user: User): { ok: false; resp: Response } | { ok: true } {
  if (user.level < 3) {
    return {
      ok: false,
      resp: Response.json(
        { ok: false, error: "Super admin (level 3) required" },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

// Wrap CF REST API. Always returns `result` on success and throws on error.
// success=false bodies surface as the first error message — that matches what
// the Dashboard would show the user.
export async function callCfApi(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  let body: { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
  try {
    body = await r.json();
  } catch {
    throw new Error(`CF API non-JSON response (HTTP ${r.status})`);
  }
  if (!body.success) {
    const msg = body.errors?.[0]?.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body.result;
}

// Show only the last 4 characters of a token — enough for the admin to
// recognise it without leaking the value.
function tokenLast4(token: string): string {
  return token.length >= 4 ? token.slice(-4) : token;
}

// Read JSON body with a uniform shape error response.
async function readJsonBody<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /edgesonic/cf/setToken { accountId, token }
// ---------------------------------------------------------------------------
// Validates the new token (calls /accounts/{id} as the new token) then pushes
// it AND the account_id into Workers Secrets via the *currently configured*
// token (env.CF_API_TOKEN). On first bootstrap when env has no token yet, we
// fall back to using the new token to write itself — works because the new
// token has Workers Scripts:Edit on the same account.
cfRoutes.post("/cf/setToken", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;

  const body = await readJsonBody<{ accountId?: string; token?: string }>(c.req.raw);
  if (!body || typeof body.token !== "string" || !body.token.trim()) {
    return c.json({ ok: false, error: "Expected { accountId, token }" }, 400);
  }
  const accountId = (body.accountId || c.env.CF_ACCOUNT_ID || "").trim();
  if (!accountId) {
    return c.json({ ok: false, error: "Missing accountId" }, 400);
  }
  const newToken = body.token.trim();

  // Step 1: validate the new token against /accounts/{id}. If this fails the
  // user pasted a wrong token or the token lacks Account Settings:Read.
  try {
    await callCfApi(newToken, `/accounts/${accountId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: `Token validation failed: ${msg}` }, 400);
  }

  // Step 2: push both as Workers Secrets. Prefer the *existing* env token so
  // a curious admin who just typed an invalid-for-this-script token still
  // can't overwrite the live secret. Falls back to newToken on bootstrap.
  const writer = c.env.CF_API_TOKEN || newToken;
  try {
    await callCfApi(
      writer,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: "CF_API_TOKEN",
          text: newToken,
          type: "secret_text",
        }),
      },
    );
    await callCfApi(
      writer,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: "CF_ACCOUNT_ID",
          text: accountId,
          type: "secret_text",
        }),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: `Secret write failed: ${msg}` }, 502);
  }

  return c.json({
    ok: true,
    tokenLast4: tokenLast4(newToken),
    accountId,
    note: "Workers Secret updated. The next request will see the new env.CF_API_TOKEN — call getStatus to confirm.",
  });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/cf/getStatus
// ---------------------------------------------------------------------------
// Returns whether env has the secrets loaded, plus the last 4 chars of the
// token for human verification. We never echo the full token.
cfRoutes.get("/cf/getStatus", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN || "";
  return c.json({
    ok: true,
    configured: !!token,
    accountId: c.env.CF_ACCOUNT_ID || "",
    tokenLast4: token ? tokenLast4(token) : "",
  });
});

// ---------------------------------------------------------------------------
// GET /edgesonic/cf/testConn
// ---------------------------------------------------------------------------
// Uses the live env.CF_API_TOKEN to call /accounts/{id} as a connectivity
// probe. Useful right after setToken to confirm the new secret took effect.
cfRoutes.get("/cf/testConn", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ ok: false, error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }, 400);
  }
  try {
    const result = await callCfApi(token, `/accounts/${accountId}`);
    // result is `{ id, name, ... }`
    const r = result as { id?: string; name?: string };
    return c.json({
      ok: true,
      accountId: r.id || accountId,
      accountName: r.name || "",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /edgesonic/cf/setCron { crons: string[] }
// ---------------------------------------------------------------------------
// Replaces the Worker's schedule list. The CF API expects a JSON array of
// `{ cron: <expr> }` objects; passing an empty array clears all schedules.
cfRoutes.post("/cf/setCron", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ ok: false, error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }, 400);
  }
  const body = await readJsonBody<{ crons?: unknown }>(c.req.raw);
  if (!body || !Array.isArray(body.crons)) {
    return c.json({ ok: false, error: "Expected { crons: string[] }" }, 400);
  }
  const crons = body.crons.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  // Light syntax check — every cron line should have 5 fields. We don't fully
  // validate cron grammar because CF returns a helpful error if it's wrong.
  for (const expr of crons) {
    if (expr.split(/\s+/).length !== 5) {
      return c.json({ ok: false, error: `Invalid cron expression (need 5 fields): ${expr}` }, 400);
    }
  }
  try {
    const result = await callCfApi(
      token,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/schedules`,
      {
        method: "PUT",
        body: JSON.stringify(crons.map((cron) => ({ cron }))),
      },
    );
    return c.json({ ok: true, schedules: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /edgesonic/cf/getCron
// ---------------------------------------------------------------------------
cfRoutes.get("/cf/getCron", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ ok: false, error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }, 400);
  }
  try {
    const result = await callCfApi(
      token,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/schedules`,
    );
    // CF returns `{ schedules: [{ cron, created_on, modified_on }] }`
    const r = result as { schedules?: Array<{ cron: string }> };
    return c.json({
      ok: true,
      schedules: r.schedules || [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /edgesonic/cf/ensureDefaultCron
// ---------------------------------------------------------------------------
// 067 — wrangler deploy clears the Worker's schedules list (the static
// [triggers] block was removed from wrangler.toml so the runtime CF API is
// the single source of truth). After every deploy a super admin opens
// Settings → Cloudflare integration and clicks "Ensure default cron"; this
// endpoint inspects the live schedules and PUTs the default 046/051/052
// cadence ("0 */1 * * *") only when the list is empty.
//
// Semantics:
//   - schedules already non-empty → no-op, returns applied=false + the
//     existing schedules so the UI can render what's live
//   - schedules empty → PUT [{ cron: "0 */1 * * *" }], returns applied=true
//     with the CF response (the new schedules list)
//
// We never overwrite a user-customised cron. If the admin wants a different
// frequency, they use the existing /cf/setCron form in Settings — this
// endpoint is purely a post-deploy "restore the hourly default" button.
const DEFAULT_CRON = "0 */1 * * *";

cfRoutes.get("/cf/ensureDefaultCron", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ ok: false, error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }, 400);
  }

  // Step 1: read the live schedules.
  let existing: Array<{ cron: string }>;
  try {
    const result = await callCfApi(
      token,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/schedules`,
    );
    const r = result as { schedules?: Array<{ cron: string }> };
    existing = r.schedules || [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 502);
  }

  // Step 2: non-empty list → respect the admin's existing config.
  if (existing.length > 0) {
    return c.json({
      ok: true,
      applied: false,
      schedules: existing,
    });
  }

  // Step 3: empty list → restore the default.
  try {
    const result = await callCfApi(
      token,
      `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/schedules`,
      {
        method: "PUT",
        body: JSON.stringify([{ cron: DEFAULT_CRON }]),
      },
    );
    return c.json({
      ok: true,
      applied: true,
      schedules: result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /edgesonic/cf/getAnalytics
// ---------------------------------------------------------------------------
// 24h rollup of Worker analytics via the GraphQL endpoint
// (api.cloudflare.com/client/v4/graphql). Returns aggregate requests, errors
// (subrequests rejected + script errors), and average CPU time in ms.
// GraphQL failures are swallowed into a { available: false } shape so the
// Settings page can show "analytics unavailable" without erroring.
cfRoutes.get("/cf/getAnalytics", async (c) => {
  const user = c.get("user");
  const guard = requireSuper(user);
  if (!guard.ok) return guard.resp;
  const token = c.env.CF_API_TOKEN;
  const accountId = c.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ ok: false, error: "CF_API_TOKEN / CF_ACCOUNT_ID not configured" }, 400);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();
  const query = `query Workers($accountTag: string, $since: Time, $until: Time, $scriptName: string) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000,
          filter: { datetime_geq: $since, datetime_leq: $until, scriptName: $scriptName }
        ) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
      }
    }
  }`;

  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: accountId,
          since,
          until,
          scriptName: SCRIPT_NAME,
        },
      }),
    });
    const j = (await r.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            workersInvocationsAdaptive?: Array<{
              sum?: { requests?: number; errors?: number };
              quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
            }>;
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };
    if (j.errors && j.errors.length > 0) {
      return c.json({
        ok: true,
        available: false,
        error: j.errors[0].message || "GraphQL error",
      });
    }
    const buckets = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    let requests = 0;
    let errors = 0;
    let cpuP50Sum = 0;
    let cpuP99Sum = 0;
    let cpuCount = 0;
    for (const b of buckets) {
      requests += b.sum?.requests || 0;
      errors += b.sum?.errors || 0;
      if (b.quantiles?.cpuTimeP50 !== undefined) {
        cpuP50Sum += b.quantiles.cpuTimeP50;
        cpuP99Sum += b.quantiles.cpuTimeP99 || 0;
        cpuCount++;
      }
    }
    return c.json({
      ok: true,
      available: true,
      since,
      until,
      requests,
      errors,
      errorRate: requests > 0 ? errors / requests : 0,
      // CF reports CPU time in microseconds; convert to milliseconds for the UI
      cpuMs: cpuCount > 0 ? +(cpuP50Sum / cpuCount / 1000).toFixed(3) : 0,
      cpuP99Ms: cpuCount > 0 ? +(cpuP99Sum / cpuCount / 1000).toFixed(3) : 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: true, available: false, error: msg });
  }
});
