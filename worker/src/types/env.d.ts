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
  // The KV namespace can be deleted from the Cloudflare dashboard.
  MUSIC_BUCKET: R2Bucket;
  INSTANCE_ID: string;
  MAX_PROXY_DEPTH?: string;
  // (pushed dynamically via /edgesonic/cf/setToken using the CF API itself,
  // not declared in wrangler.toml). Unset until the admin runs first-time
  // setup from the Settings page.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  //  wrangler secret put WORK_UPLOAD_HMAC_KEY
  // (≥32 random bytes, e.g. `openssl rand -base64 48`). Unset → falls back
  // to INSTANCE_ID + static salt; see worker/src/utils/workUploadToken.ts.
  WORK_UPLOAD_HMAC_KEY?: string;
  // can detect a deploy without a hard refresh. Bump per deploy via either:
  //  - wrangler.toml [vars] WORKER_VERSION = "<n>" (default; bump before deploy)
  //  - `wrangler deploy --var WORKER_VERSION:$(date +%s)` (one-shot override)
  // Unset → endpoint returns "0".
  WORKER_VERSION?: string;
  // push secrets into this same Worker. Defaults to "edgesonic" when unset so
  // existing deployments keep working without a redeploy.
  WORKER_NAME?: string;
  // feature `enable_r2_presign` is '1', the /rest/stream raw+r2 branch
  // 302-redirects the browser to a short-lived presigned R2 S3 URL,
  // bypassing the Worker sub-request bandwidth pool. The R2 account id
  // is read from `CF_ACCOUNT_ID` (already pushed as a Workers Secret by
  // the Settings → Cloudflare integration sub-block, task 054) — no
  // separate R2_ACCOUNT_ID secret is needed. Push via:
  //  wrangler secret put R2_ACCESS_KEY_ID
  //  wrangler secret put R2_SECRET_ACCESS_KEY
  // See worker/SECRETS.md §3.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Permission matrix cache, pushed dynamically via
  // POST /edgesonic/permissions/save using the same CF-API-secret-write
  // pattern as CF_API_TOKEN (054/cf.ts:setToken) — no redeploy needed. JSON
  // shape: `{ [level: string]: { [permission: string]: boolean } }`.
  // Read before D1 in permissionMiddleware/hasPermission (utils/
  // permissions.ts); D1's user_permissions.enabled column is the fallback
  // when this is unset or fails to parse.
  PERMISSIONS_OVERRIDE?: string;
  // Mirrors [[r2_buckets]] bucket_name in wrangler.toml — R2Bucket bindings
  // don't expose their own bucket name at runtime. Used only for the
  // read-only R2 detail card in Sources.vue.
  R2_BUCKET_NAME?: string;
  // Post-deploy cron auto-recovery state, pushed dynamically as a Workers
  // Secret via the CF API (same mechanism as CF_API_TOKEN / PERMISSIONS_OVERRIDE
  // — no redeploy needed). JSON shape: `{ "crons": string[], "build": string }`
  // where `build` is the WORKER_VERSION cron was last applied under. Read as the
  // fast primary (a Secret survives `wrangler deploy`); the kv_store D1 row
  // `cron_recovery_state` is the durable backup. See utils/cronRecovery.ts.
  CRON_STATE?: string;
}
