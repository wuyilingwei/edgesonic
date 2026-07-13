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

// Post-deploy cron auto-recovery ("workflow recovery").
//
// `wrangler deploy` wipes the Worker's Cloudflare cron triggers on every run
// (wrangler.toml intentionally carries no [triggers] block — schedules are
// managed at runtime via the CF API; see cf.ts). Historically a super admin
// had to open Settings → Cloudflare and click "Ensure default cron" after each
// deploy or the hourly maintenance jobs stopped firing.
//
// This module automates that. Whenever cron is applied through the app we
// record `{ crons, build }`, where `build` is the WORKER_VERSION it was applied
// under. The record is stored in a Workers Secret (`env.CRON_STATE`, the fast
// primary — a Secret survives `wrangler deploy`, unlike a [vars] value) and,
// as a durable backup, in the `kv_store` D1 table. On the next super-admin
// login we compare the recorded build against the currently deployed
// WORKER_VERSION; a mismatch means a deploy happened since cron was last
// applied (so the schedules were cleared), and the recorded schedule is
// re-applied automatically — falling back to the D1 backup when the Secret is
// absent, and to the hourly default when there is no record at all.
//
// Everything here touches the Cloudflare API token, so callers MUST gate on the
// super admin (level 3) — the login hook does exactly that. Every operation is
// best-effort: a failure returns a status object and never throws, so it can
// run in a waitUntil() without risking the login response.

const KV_KEY = "cron_recovery_state";
const SECRET_NAME = "CRON_STATE";
const DEFAULT_CRON = "0 */1 * * *";

export interface CronState {
  crons: string[];
  build: string;
}

export type RecoverResult =
  | { status: "skipped-no-cf" }
  | { status: "up-to-date"; build: string }
  | { status: "recovered"; crons: string[]; previousBuild: string; build: string }
  | { status: "bootstrapped"; crons: string[]; build: string }
  | { status: "error"; error: string };

function scriptName(env: Env): string {
  return env.WORKER_NAME || "edgesonic";
}

function currentBuild(env: Env): string {
  return env.WORKER_VERSION || "0";
}

// Minimal CF REST wrapper. Kept local (rather than importing cf.ts::callCfApi)
// so this module has no dependency on cf.ts — cf.ts imports persistCronState
// from here, and a two-way import would be a cycle.
async function cfApi(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
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
    throw new Error(body.errors?.[0]?.message || `HTTP ${r.status}`);
  }
  return body.result;
}

function parseState(raw: string | undefined | null): CronState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<CronState>;
    if (!o || !Array.isArray(o.crons) || typeof o.build !== "string") return null;
    return {
      crons: o.crons.filter((s): s is string => typeof s === "string" && s.trim().length > 0),
      build: o.build,
    };
  } catch {
    return null;
  }
}

// Read the recovery record: the env Secret first (a pure env read, no D1
// round-trip on the common up-to-date path), the D1 backup second.
export async function readCronState(env: Env): Promise<CronState | null> {
  const fromEnv = parseState(env.CRON_STATE);
  if (fromEnv) return fromEnv;
  try {
    const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?")
      .bind(KV_KEY)
      .first<{ value: string }>();
    return row ? parseState(row.value) : null;
  } catch {
    return null;
  }
}

// Persist the record to D1 (always — the durable source of truth) and mirror it
// into the Workers Secret (best-effort; needs a token with Workers Scripts:Edit,
// and a failure is non-fatal because D1 already holds it).
export async function persistCronState(env: Env, state: CronState): Promise<void> {
  const value = JSON.stringify(state);
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(KV_KEY, value, now).run();
  } catch {
    /* D1 write failure must not break the caller */
  }

  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) return;
  try {
    await cfApi(
      token,
      `/accounts/${accountId}/workers/scripts/${scriptName(env)}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify({ name: SECRET_NAME, text: value, type: "secret_text" }),
      },
    );
  } catch {
    /* the Secret mirror is an optimisation; D1 remains authoritative */
  }
}

async function getLiveCrons(env: Env, token: string, accountId: string): Promise<string[]> {
  const result = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${scriptName(env)}/schedules`,
  );
  const r = result as { schedules?: Array<{ cron?: string }> };
  return (r.schedules || []).map((s) => (s.cron || "").trim()).filter(Boolean);
}

async function putCrons(env: Env, token: string, accountId: string, crons: string[]): Promise<void> {
  await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${scriptName(env)}/schedules`,
    {
      method: "PUT",
      body: JSON.stringify(crons.map((cron) => ({ cron }))),
    },
  );
}

// Compare the recorded build against the live WORKER_VERSION and re-apply the
// cron schedule when a deploy has cleared it. Caller MUST already have verified
// the request is from a super admin — this uses the CF API token.
export async function recoverCronIfStale(env: Env): Promise<RecoverResult> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) return { status: "skipped-no-cf" };

  const build = currentBuild(env);
  try {
    const stored = await readCronState(env);

    // Common path: build matches → cron intact since it was last applied.
    if (stored && stored.build === build) {
      return { status: "up-to-date", build };
    }

    // Build changed since cron was last applied → a deploy cleared the
    // schedules. Re-apply the recorded config (drawn from the D1 backup when
    // the Secret is gone); fall back to the hourly default if it was empty.
    if (stored) {
      const crons = stored.crons.length > 0 ? stored.crons : [DEFAULT_CRON];
      await putCrons(env, token, accountId, crons);
      await persistCronState(env, { crons, build });
      return { status: "recovered", crons, previousBuild: stored.build, build };
    }

    // No record yet → establish a baseline so future deploys have something to
    // restore. Adopt whatever is live now; if nothing is live (e.g. a deploy
    // just cleared it and we never recorded), apply the hourly default.
    const live = await getLiveCrons(env, token, accountId);
    const crons = live.length > 0 ? live : [DEFAULT_CRON];
    if (live.length === 0) {
      await putCrons(env, token, accountId, crons);
    }
    await persistCronState(env, { crons, build });
    return { status: "bootstrapped", crons, build };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
