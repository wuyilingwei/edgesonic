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
}
