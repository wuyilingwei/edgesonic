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

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  MUSIC_BUCKET: R2Bucket;
  INSTANCE_ID: string;
  MAX_PROXY_DEPTH?: string;
  // 054 — Cloudflare API integration. Both are stored as Workers Secrets
  // (pushed dynamically via /edgesonic/cf/setToken using the CF API itself,
  // not declared in wrangler.toml). Unset until the admin runs first-time
  // setup from the Settings page.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // 066 — HMAC key for browser-pool upload tokens. Push via
  //   wrangler secret put WORK_UPLOAD_HMAC_KEY
  // (≥32 random bytes, e.g. `openssl rand -base64 48`). Unset → falls back
  // to INSTANCE_ID + static salt; see worker/src/utils/workUploadToken.ts.
  WORK_UPLOAD_HMAC_KEY?: string;
  // 081 — Worker bundle version, surfaced by GET /edgesonic/version so the SPA
  // can detect a deploy without a hard refresh. Bump per deploy via either:
  //   - wrangler.toml [vars] WORKER_VERSION = "<n>"  (default; bump before deploy)
  //   - `wrangler deploy --var WORKER_VERSION:$(date +%s)`  (one-shot override)
  // Unset → endpoint returns "0".
  WORKER_VERSION?: string;
  // 093 — Worker script name. Used by CF API calls (cf.ts / r2presign.ts) to
  // push secrets into this same Worker. Defaults to "edgesonic" when unset so
  // existing deployments keep working without a redeploy.
  WORKER_NAME?: string;
  // 091 — R2 S3 presigned URL credentials. When both are set AND
  // feature `enable_r2_presign` is '1', the /rest/stream raw+r2 branch
  // 302-redirects the browser to a short-lived presigned R2 S3 URL,
  // bypassing the Worker sub-request bandwidth pool. The R2 account id
  // is read from `CF_ACCOUNT_ID` (already pushed as a Workers Secret by
  // the Settings → Cloudflare integration sub-block, task 054) — no
  // separate R2_ACCOUNT_ID secret is needed. Push via:
  //   wrangler secret put R2_ACCESS_KEY_ID
  //   wrangler secret put R2_SECRET_ACCESS_KEY
  // See worker/SECRETS.md §3.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
