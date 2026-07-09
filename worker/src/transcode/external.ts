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

//
// Calls a self-hosted Node + ffmpeg container (docker/external-transcoder)
// over plain HTTPS, protected by a shared key sent in
// `X-EdgeSonic-Container-Key`. The container endpoint maps 1:1 onto the
// SandboxTranscodeEngine semantics so callers can swap freely.
//
// The endpoint URL lives in features.external_transcoder_url (visible) and
// the shared key in external_secrets.external_transcoder_key (admin-only,
// never sent to getFeatures).

import type {
  TranscodeEngine, TranscodeInput, TranscodeJobRow, TranscodeOutput, TranscodeProfile,
} from "./engine";

export interface ExternalEngineOptions {
  url: string;        // e.g. https://transcoder.fly.dev
  sharedKey: string;  // ≥32 random bytes; injected by Worker on every call
  // Optional per-request timeout. The Worker subrequest budget caps this
  // upstream; we keep a soft cap so a stuck container can't hold the request
  // forever. Default = 0 (no soft cap, let the platform decide).
  softTimeoutMs?: number;
}

export class ExternalTranscodeEngine implements TranscodeEngine {
  readonly name = "external";

  constructor(private readonly opts: ExternalEngineOptions) {
    if (!opts.url) throw new Error("ExternalTranscodeEngine: url required");
    if (!opts.sharedKey) throw new Error("ExternalTranscodeEngine: sharedKey required");
  }

  async transcode(input: TranscodeInput, profile: TranscodeProfile): Promise<TranscodeOutput> {
    // POST /transcode?profile=<id> raw body → streamed audio.
    const url = `${stripTrailingSlash(this.opts.url)}/transcode?profile=${encodeURIComponent(profile.id)}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": input.contentType ?? "application/octet-stream",
        "X-EdgeSonic-Container-Key": this.opts.sharedKey,
      },
      body: input.body as BodyInit,
    };

    const resp = await this.fetchWithTimeout(url, init);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "<no body>");
      throw new Error(`external transcoder failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
    }
    if (!resp.body) {
      throw new Error("external transcoder returned no body");
    }

    return {
      body: resp.body,
      contentType: profile.contentType,
    };
  }

  async getStatus(jobId: string): Promise<TranscodeJobRow | null> {
    // Container can optionally expose /status/:jobId for pre-bake mode.
    // The dispatcher prefers D1 — this is a best-effort probe for debugging.
    try {
      const url = `${stripTrailingSlash(this.opts.url)}/status/${encodeURIComponent(jobId)}`;
      const resp = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { "X-EdgeSonic-Container-Key": this.opts.sharedKey },
      });
      if (!resp.ok) return null;
      const data = await resp.json<TranscodeJobRow>().catch(() => null);
      return data ?? null;
    } catch {
      return null;
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      const url = `${stripTrailingSlash(this.opts.url)}/jobs/${encodeURIComponent(jobId)}`;
      await this.fetchWithTimeout(url, {
        method: "DELETE",
        headers: { "X-EdgeSonic-Container-Key": this.opts.sharedKey },
      });
    } catch {
      // Cancellation is fire-and-forget; the Worker subrequest budget can swallow this.
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = `${stripTrailingSlash(this.opts.url)}/health`;
      const resp = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: { "X-EdgeSonic-Container-Key": this.opts.sharedKey },
      });
      if (!resp.ok) return false;
      const txt = await resp.text();
      return txt.trim() === "ok";
    } catch {
      return false;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeout = this.opts.softTimeoutMs ?? 0;
    if (timeout <= 0) return fetch(url, init);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
