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

// 049 + 036 — Shared transcode-engine factory.
//
// Both /rest/transcodeFile (manual trigger, in endpoints/transcode.ts) and
// /rest/stream (on-demand transcoding for format / maxBitRate, in endpoints/
// media.ts) need to materialise the currently-selected TranscodeEngine from
// feature flags. This factory keeps the resolution logic in one place so the
// two call sites cannot drift, and provides a test hook so on-demand-stream
// tests can inject a FakeEngine without monkey-patching @cloudflare/sandbox.
//
// Resolution mirrors the original buildEngine() that shipped with 049:
//   transcode_engine = 'disabled' → null
//   transcode_engine = 'sandbox'  → SandboxTranscodeEngine (requires the
//                                   Sandbox DO binding)
//   transcode_engine = 'external' → ExternalTranscodeEngine (requires
//                                   external_transcoder_url + secret)
// Any misconfiguration returns null — callers fall back to direct streaming.

// Engine classes are loaded lazily — both pull in @cloudflare/sandbox /
// @cloudflare/containers which require the `cloudflare:workers` resolution
// only available inside `wrangler`. Loading them at module top would break
// any test that wants to inject a FakeEngine via __setEngineFactoryForTest.
import type { Sandbox } from "@cloudflare/sandbox";
import { getFeatureString } from "../utils/features";
import type { EngineKind, TranscodeEngine } from "./engine";

export interface ResolvedEngine {
  engine: TranscodeEngine;
  kind: EngineKind;
}

// Test override. Production calls leave this null; tests assign a function via
// __setEngineFactoryForTest() to short-circuit resolution.
let testOverride: ((env: Env) => Promise<ResolvedEngine | null>) | null = null;

export function __setEngineFactoryForTest(
  fn: ((env: Env) => Promise<ResolvedEngine | null>) | null,
): void {
  testOverride = fn;
}

export async function buildTranscodeEngine(env: Env): Promise<ResolvedEngine | null> {
  if (testOverride) return testOverride(env);

  const kind = ((await getFeatureString(env, "transcode_engine", "disabled")) as EngineKind) || "disabled";

  if (kind === "disabled") return null;

  if (kind === "sandbox") {
    // The Sandbox DO namespace is declared in wrangler.toml. The generic is
    // `any` because we only call containerFetch() — never the DO's own RPC.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (env as unknown as { Sandbox?: DurableObjectNamespace<Sandbox<any>> }).Sandbox;
    if (!ns) return null;
    const { SandboxTranscodeEngine } = await import("./sandbox");
    return { engine: new SandboxTranscodeEngine({ Sandbox: ns }), kind };
  }

  if (kind === "external") {
    const url = await getFeatureString(env, "external_transcoder_url", "");
    if (!url) return null;
    const secret = await env.DB
      .prepare("SELECT value FROM external_secrets WHERE key = 'external_transcoder_key'")
      .first<{ value: string }>();
    if (!secret?.value) return null;
    const { ExternalTranscodeEngine } = await import("./external");
    return {
      engine: new ExternalTranscodeEngine({ url, sharedKey: secret.value }),
      kind,
    };
  }

  // 053 — Browser-pool engine. No bindings to verify beyond DB / MUSIC_BUCKET
  // which are required by every other code path already; the queue is the
  // contract, and an empty pool of browser workers just means rows sit
  // queued until somebody opens the web UI.
  if (kind === "browser_pool") {
    const { BrowserPoolEngine } = await import("./browser_pool");
    return { engine: new BrowserPoolEngine(env.DB, env.MUSIC_BUCKET), kind };
  }

  return null;
}
