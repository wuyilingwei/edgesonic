//
// To unlock SharedArrayBuffer (required for ffmpeg.wasm multi-threading in
// the browser work pool) we have to flip `crossOriginIsolated = true` in every
// EdgeSonic origin tab. That demands three headers on the document and every
// resource the page loads from the same origin:
//   Cross-Origin-Opener-Policy:   same-origin       (isolates the BrowsingContext)
//   Cross-Origin-Embedder-Policy: require-corp      (every subresource needs a CORP grant)
//   Cross-Origin-Resource-Policy: same-origin       (default grant: only embeddable by same-origin pages)
//
// All EdgeSonic traffic is same-origin to the SPA, so a same-origin CORP keeps
// covers / streams / shares working without exposing them to cross-origin
// embedders. The feature is gated by feature_strings.enable_cross_origin_isolation
// — flip to '0' to roll back without redeploying. Handlers may set their own
// CORP (e.g. `cross-origin`) before this middleware runs; we only fill the
// default when the header is absent.
//
// Lives in its own file (instead of inline in index.ts) so the test suite can
// import it without dragging in the @cloudflare/sandbox container binding from
// index.ts's top-level re-export.

import { getFeatureString } from "../utils/features";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoLikeContext = { env: any; res: { headers: Headers } & Partial<Response> };
type Next = () => Promise<void>;

export const crossOriginIsolationMiddleware = async (
  c: HonoLikeContext,
  next: Next,
): Promise<void> => {
  await next();
  const env = c.env as Env;
  // Best-effort: if features util is unreachable (e.g. during D1 outage) we
  // skip stamping rather than 500 the entire response. Default is ON in the
  // 0022 migration so first-tick after deploy already has headers.
  let enabled = true;
  try {
    const value = await getFeatureString(env, "enable_cross_origin_isolation", "1");
    enabled = value !== "0";
  } catch { enabled = true; }
  if (!enabled) return;
  // whose headers are immutable. Setting on them throws "Can't modify immutable
  // headers" and 500s the whole response. Clone into a mutable copy when needed
  // so the cross-origin headers still land without breaking the redirect.
  try {
    c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  } catch {
    // Reconstruct as a fresh mutable Response. Body may be null (e.g. 302
    // redirect with no body) — pass through whatever the original had.
    const orig = c.res as Response;
    c.res = new Response(orig.body, {
      status: orig.status,
      statusText: orig.statusText,
      headers: orig.headers,
    });
    c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    if (!c.res.headers.has("Cross-Origin-Resource-Policy")) {
      c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
    return;
  }
  c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  if (!c.res.headers.has("Cross-Origin-Resource-Policy")) {
    c.res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
};
