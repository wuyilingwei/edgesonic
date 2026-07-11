//
// Drives the worker/transcoder-image container via @cloudflare/sandbox.
// The container exposes:
//  GET /health
//   POST /transcode?args=<json-argv> (raw audio body in, raw audio out)
// We synthesise the argv via buildFfmpegArgs(profile) and forward the request
// through `sandbox.containerFetch(url, init, 8080)` so the request → ffmpeg
// → response streams the whole way.
//
// The sandbox ID is derived from the transcode job ID, so concurrent jobs
// land in their own Durable Object + container instance, up to
// `max_instances` configured in wrangler.toml.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { TranscodeEngine, TranscodeInput, TranscodeJobRow, TranscodeOutput, TranscodeProfile } from "./engine";
import { buildFfmpegArgs } from "./profiles";

// Bindings provided by wrangler.toml. The Sandbox class is re-exported from
// src/index.ts; this is its DurableObjectNamespace binding. The unknown
// generic matches the binding declared in wrangler.toml — we never call the
// DO's own RPC methods directly, only containerFetch().
interface SandboxBindings {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Sandbox: DurableObjectNamespace<Sandbox<any>>;
}

export interface SandboxEngineOptions {
  // Which sandboxId pool to share. Defaults to "edgesonic-transcoder".
  // 036 may switch to per-user pools to throttle isolation.
  sandboxId?: string;
  // Port the container is listening on. Matches EXPOSE in the Dockerfile.
  port?: number;
}

export class SandboxTranscodeEngine implements TranscodeEngine {
  readonly name = "sandbox";

  // We use a single shared sandbox keyed by `sandboxId` so cold starts amortise
  // across requests. Per-job sandboxes would be ideal but Workers Free has a
  // strict DO instance limit — share until we have data showing contention.
  private readonly sandboxId: string;
  private readonly port: number;

  constructor(
    private readonly env: SandboxBindings,
    opts: SandboxEngineOptions = {},
  ) {
    this.sandboxId = opts.sandboxId ?? "edgesonic-transcoder";
    this.port = opts.port ?? 8080;
  }

  async transcode(input: TranscodeInput, profile: TranscodeProfile): Promise<TranscodeOutput> {
    const sb = getSandbox(this.env.Sandbox, this.sandboxId);

    const args = buildFfmpegArgs(profile);
    const argsParam = encodeURIComponent(JSON.stringify(args));
    // The host is meaningless because containerFetch routes via the DO;
    // we only care about path + query.
    const url = `http://sandbox/transcode?args=${argsParam}`;

    const body = input.body instanceof Uint8Array
      ? input.body
      // The Sandbox SDK forwards ReadableStream<Uint8Array> as-is. We must
      // not consume it here — it stays unread until the container reads it.
      : input.body;

    const init: RequestInit = {
      method: "POST",
      body: body as BodyInit,
      headers: {
        "Content-Type": input.contentType ?? "application/octet-stream",
      },
    };

    // containerFetch handles port forwarding into the running container.
    // It returns a streaming Response — perfect for piping to the Worker
    // response.
    const resp = await sb.containerFetch(url, init, this.port);

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "<no body>");
      throw new Error(`sandbox transcode failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
    }
    if (!resp.body) {
      throw new Error("sandbox transcode returned no body");
    }

    return {
      body: resp.body,
      contentType: profile.contentType,
    };
  }

  // Sandbox engine has no remote job tracking — status is whatever the
  // dispatcher persisted in transcode_jobs. Caller falls back to D1.
  async getStatus(_jobId: string): Promise<TranscodeJobRow | null> {
    return null;
  }

  // Cancel is fire-and-forget: closing the upstream request kills the
  // ffmpeg child (see app.js req.on("close")). No remote endpoint to call.
  async cancel(_jobId: string): Promise<void> {
    return;
  }

  // Probe the container's /health endpoint. Cold-start cost is unavoidable
  // on first invocation; subsequent calls return in single-digit ms.
  async healthCheck(): Promise<boolean> {
    try {
      const sb = getSandbox(this.env.Sandbox, this.sandboxId);
      const resp = await sb.containerFetch("http://sandbox/health", { method: "GET" }, this.port);
      if (!resp.ok) return false;
      const txt = await resp.text();
      return txt.trim() === "ok";
    } catch {
      return false;
    }
  }
}
