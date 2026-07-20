// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Demo mode periodic reset. Runs off the scheduled() handler. Every
// DEMO_RESET_CRON tick (default 6h) it:
//   1. Reloads features / feature_strings / user_permissions from the
//      bundled worker/demo-template.json (or DEMO_TEMPLATE_OVERRIDE).
//   2. Clears the R2 bucket of any key outside the keep-prefix whitelist
//      (demo-library/, avatars/). Visitor uploads under music/, cache/,
//      _uploads/ etc. are wiped.
//   3. Restores every key under demo-library/ to the versionId captured by
//      the last superadmin-triggered snapshot (see
//      utils/demoR2Snapshot.ts). This rolls back any visitor modification
//      to the demo library without re-uploading bytes via CI.
//
// Self-gated via a D1 kv_store row so it survives the 15-minute Worker
// isolate lifetime. The first tick after DEMO_MODE is enabled always runs
// immediately so the instance is clean from boot.

import type { DemoTemplate } from "./demoTemplate";
import { isDemoKeptR2Key } from "./demoMode";
import { restoreDemoLibrarySnapshot } from "./demoR2Snapshot";

const GATE_KEY = "demo:last_reset_ts";
const DEFAULT_INTERVAL_SEC = 6 * 60 * 60;

async function loadTemplate(env: Env): Promise<DemoTemplate> {
  if (env.DEMO_TEMPLATE_OVERRIDE) {
    try {
      const r = await fetch(env.DEMO_TEMPLATE_OVERRIDE);
      if (r.ok) return await r.json() as DemoTemplate;
    } catch (e) {
      console.error("[demoReset] template override fetch failed:", e);
    }
  }
  // Bundled asset. The ASSETS binding serves files from web/dist, not from
  // worker/, so we can't use c.env.ASSETS here. Instead the template was
  // inlined into the Worker bundle via a `?? import` at build time — but
  // Wrangler doesn't support arbitrary file imports out of the box, so we
  // ship the template as JSON inside the source tree and import it.
  return (await import("./demoTemplate")).defaultTemplate;
}

async function gatePassed(env: Env, intervalSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB
    .prepare("SELECT value FROM kv_store WHERE key = ?")
    .bind(GATE_KEY)
    .first<{ value: string }>();
  const last = row ? parseInt(row.value, 10) : 0;
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalSec;
}

async function markGate(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      "INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(GATE_KEY, String(now))
    .run();
}

async function resetFeatures(env: Env, tpl: DemoTemplate): Promise<void> {
  if (tpl.features) {
    for (const [key, value] of Object.entries(tpl.features)) {
      await env.DB
        .prepare("UPDATE features SET value = ?, updated_at = ? WHERE key = ?")
        .bind(value, Math.floor(Date.now() / 1000), key)
        .run();
    }
  }
  if (tpl.feature_strings) {
    for (const [key, value] of Object.entries(tpl.feature_strings)) {
      await env.DB
        .prepare("UPDATE feature_strings SET value = ?, updated_at = ? WHERE key = ?")
        .bind(value, Math.floor(Date.now() / 1000), key)
        .run();
    }
  }
}

async function resetPermissions(env: Env, tpl: DemoTemplate): Promise<void> {
  if (!tpl.user_permissions) return;
  for (const [levelKey, perms] of Object.entries(tpl.user_permissions)) {
    const level = parseInt(levelKey, 10);
    if (!Number.isFinite(level)) continue;
    for (const [perm, enabled] of Object.entries(perms)) {
      await env.DB
        .prepare(
          "UPDATE user_permissions SET enabled = ? WHERE level = ? AND permission = ?",
        )
        .bind(enabled ? 1 : 0, level, perm)
        .run();
    }
  }
}

async function resetR2(env: Env): Promise<void> {
  const bucket = env.MUSIC_BUCKET;
  // R2 list returns up to 1000 keys per page; loop until exhausted.
  // eslint-disable-next-line no-constant-condition
  let cursor: string | undefined;
  let deleted = 0;
  while (true) {
    const listed = await bucket.list({ cursor, limit: 1000 });
    const toDelete = listed.objects
      .map((o) => o.key)
      .filter((k) => !isDemoKeptR2Key(k));
    for (const key of toDelete) {
      await bucket.delete(key);
      deleted++;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  if (deleted > 0) {
    console.log(`[demoReset] cleared ${deleted} non-whitelisted R2 keys`);
  }
}

export async function maybeRunDemoReset(env: Env): Promise<void> {
  if ((env.DEMO_MODE || "").trim() !== "1") return;
  const intervalSec = (() => {
    const raw = parseInt(env.DEMO_RESET_CRON || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_SEC;
  })();
  if (!(await gatePassed(env, intervalSec))) return;
  const tpl = await loadTemplate(env);
  await resetFeatures(env, tpl);
  await resetPermissions(env, tpl);
  await resetR2(env);
  // Roll back demo-library/ to the last superadmin-recorded snapshot. No-op
  // if no snapshot exists yet (e.g. brand-new demo instance — visitors see
  // an empty library until the operator runs /edgesonic/demo/snapshot).
  const restoreResult = await restoreDemoLibrarySnapshot(env).catch((e) => {
    console.error("[demoReset] restoreDemoLibrarySnapshot failed:", e);
    return null;
  });
  if (restoreResult && restoreResult.ok) {
    console.log(`[demoReset] restored ${restoreResult.restored} demo-library keys (${restoreResult.skipped} skipped)`);
  }
  await markGate(env);
  console.log("[demoReset] reset complete");
}