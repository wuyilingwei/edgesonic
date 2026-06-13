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
  // 068 — AES-256-GCM master key for storage_sources.password_encrypted.
  // 64 hex chars (32 bytes); push via
  //   wrangler secret put STORAGE_KEY
  // Unset → storage_sources passwords stay in the legacy plaintext column,
  // and /storage/sources/migratePasswords refuses to run. See worker/SECRETS.md.
  STORAGE_KEY?: string;
  // 081 — Worker bundle version, surfaced by GET /edgesonic/version so the SPA
  // can detect a deploy without a hard refresh. Bump per deploy via either:
  //   - wrangler.toml [vars] WORKER_VERSION = "<n>"  (default; bump before deploy)
  //   - `wrangler deploy --var WORKER_VERSION:$(date +%s)`  (one-shot override)
  // Unset → endpoint returns "0".
  WORKER_VERSION?: string;
}
