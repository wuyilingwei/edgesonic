# EdgeSonic Worker Secrets

This document lists the Cloudflare Workers Secrets that EdgeSonic recognises
at runtime. All secrets are optional — the worker falls back to safe defaults
when a secret is absent — but **production deployments should configure every
one of them**.

Secrets live in the Worker's encrypted secret store, not in `wrangler.toml` or
the repository. They are bound to `env.<NAME>` at runtime exactly like normal
bindings.

| Name | Owner task | Purpose | Required in prod? |
| ---- | ---------- | ------- | ----------------- |
| `WORK_UPLOAD_HMAC_KEY` | 066 | HMAC-SHA-256 key for browser-pool transcode upload tokens (`/edgesonic/work/upload`). | Yes |
| `CF_API_TOKEN` | 054 | Cloudflare API token for cron / analytics integration. Pushed dynamically via `/edgesonic/cf/setToken`. | Yes (set via Settings UI) |
| `CF_ACCOUNT_ID` | 054 | Cloudflare account id paired with `CF_API_TOKEN`. | Yes (set via Settings UI) |
| `R2_ACCESS_KEY_ID` | 091 | R2 S3 access key for presigned URL signing. Pair with `R2_SECRET_ACCESS_KEY`. | Yes (to enable presign) |
| `R2_SECRET_ACCESS_KEY` | 091 | R2 S3 secret key for presigned URL signing. | Yes (to enable presign) |
| `R2_ACCOUNT_ID` | 091 | Cloudflare account id hosting the R2 bucket. Defaults to `wrangler.toml` `account_id` if absent, but must be set as a secret for presign to activate. | Yes (to enable presign) |

---

## 1. `WORK_UPLOAD_HMAC_KEY` (task 066)

### Why

Browser-pool workers receive a one-shot upload URL of the form

```
/edgesonic/work/upload?id=<workQueueId>&token=<token>
```

The token is `<expUnix>.<base64url(HMAC-SHA-256("<workQueueId>:<exp>"))>`,
signed with a key derived from this secret. The TTL is 5 minutes and the
upload endpoint additionally requires that the caller's session matches
`work_queue.claimed_by`, so even a leaked token can only be redeemed by the
worker that claimed the row.

If `WORK_UPLOAD_HMAC_KEY` is **unset or empty**, the worker falls back to
`<INSTANCE_ID>:esp-upload-v1` (the 053-era static salt). This fallback exists
purely to avoid hard-breaking deployments that haven't yet pushed the secret
— it should **not** be relied upon in production because `INSTANCE_ID` is not
treated as a secret elsewhere in the codebase.

### How to set (recommended: `wrangler` CLI)

```bash
# Generate ≥32 random bytes
openssl rand -base64 48 | tr -d '\n' | pbcopy   # macOS clipboard
# or just: openssl rand -base64 48

# Push it (you will be prompted to paste the value)
cd worker
wrangler secret put WORK_UPLOAD_HMAC_KEY
```

Verify with:

```bash
wrangler secret list
# expect: WORK_UPLOAD_HMAC_KEY  Secret
```

### How to set (alternative: Cloudflare API, mirrors 054 `setToken` flow)

If you cannot run `wrangler` locally — e.g. during a CF-API-only bootstrap —
you can PUT the secret directly with a token that has the
`Workers Scripts:Edit` permission:

```bash
ACCOUNT_ID="<your-account-id>"
SCRIPT_NAME="edgesonic"      # adjust if you renamed the worker
TOKEN="$(cat <<'EOF'
<paste your CF_API_TOKEN here>
EOF
)"

curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/secrets" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{
  "name": "WORK_UPLOAD_HMAC_KEY",
  "text": "$(openssl rand -base64 48)",
  "type": "secret_text"
}
JSON
```

This is the same API surface that `/edgesonic/cf/setToken` (task 054) uses
internally. A future task may add `setUploadKey` to the Settings UI; for now
it is admin-managed only.

### Rotation

Rotating the secret invalidates all outstanding upload tokens immediately
(they were signed under the old key). The `work_queue` rows themselves
survive, so any task that hasn't yet uploaded will be picked up by another
worker after the claim TTL expires (default 5 min — see `worker_claim_ttl_seconds`
feature string from task 052a).

```bash
wrangler secret put WORK_UPLOAD_HMAC_KEY   # overwrite
```

### Length / entropy

- Minimum 32 bytes of cryptographic randomness.
- `openssl rand -base64 48` is the recommended generator (48 raw bytes → 64
  base64 chars; well above the 256-bit security level used by SHA-256).
- Do **not** reuse `CF_API_TOKEN` or `INSTANCE_ID` as the key — they live in
  different trust domains.

---

## 2. `CF_API_TOKEN` / `CF_ACCOUNT_ID` (task 054)

These are managed through the Settings UI → "Cloudflare 集成" sub-block. See
the docstring in `worker/src/endpoints/edgesonic/cf.ts` and the inline notes in
`worker/src/types/env.d.ts` for the full flow. They are listed here only so
operators have a single inventory of all secrets the worker reads.

---

## 3. `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` (task 091)

### Why

The `/rest/stream` endpoint serves R2 bytes by reading the object inside the
Worker and streaming the body back to the browser. Cloudflare does not
publish a per-sub-request bandwidth limit, but in practice multiple
concurrent sub-requests on the same Worker invocation share an outbound
channel — production observed ~1.2 MB/s when the browser work pool ran 3
metadata fetches alongside the playing stream.

Task 091 adds an optional short-circuit: when `enable_r2_presign` is `'1'`
AND all three R2 secrets are set, the stream endpoint signs a 5-minute
SigV4 presigned URL and returns a **302 redirect**. The browser then fetches
R2 bytes directly from the R2 S3 endpoint, entirely outside the Worker
sub-request budget. R2 egress is free, so this costs nothing extra.

When any of the three secrets is unset (or the feature flag is `'0'`), the
endpoint falls back to the existing in-Worker stream — no behaviour change.

### How to create the R2 S3 API token

1. Cloudflare dashboard → **R2 → Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read** (only — presigned URLs are GET-only; the
   worker never writes through S3).
3. Specify bucket: `edgesonic-music` (or `*` if you prefer a single token
   for future buckets).
4. TTL: leave default (no expiry) or set a rotation window.
5. On creation Cloudflare shows **Access Key ID** and **Secret Access Key**
   **once**. Copy them immediately — the secret is never shown again.

### How to set the secrets

```bash
cd worker

# The Access Key ID (safe to echo — it's like a username)
wrangler secret put R2_ACCESS_KEY_ID
# paste the Access Key ID from the R2 dashboard

# The Secret Access Key (sensitive — handle like a password)
wrangler secret put R2_SECRET_ACCESS_KEY
# paste the Secret Access Key from the R2 dashboard

# The Cloudflare account id hosting the bucket
wrangler secret put R2_ACCOUNT_ID
# paste df4481f3ce1fa0394b4617442a97d147 (or your own)
```

Verify:

```bash
wrangler secret list
# expect: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID
```

### Enabling the feature flag

After pushing the three secrets, flip the flag:

```bash
# Via the Settings UI → Feature Strings → enable_r2_presign → set to "1"
# Or via D1 directly:
npx wrangler d1 execute edgesonic-db --remote --command \
  "UPDATE feature_strings SET value='1', updated_at=unixepoch() WHERE key='enable_r2_presign'"
```

The in-isolate memory cache has a 60s TTL, so the change takes effect within
a minute without a redeploy.

### Rotation

Rotating the R2 S3 API token does **not** invalidate already-issued presigned
URLs until their 5-minute TTL elapses (the signature is computed from the
secret at presign time, not verified against R2's live token list). To rotate:

1. Create a new R2 API token in the dashboard.
2. `wrangler secret put R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` with the
   new values.
3. Wait 5 minutes for outstanding presigned URLs to drain.

### Security notes

- Presigned URLs are **per-object, 5-minute TTL**. A leaked URL gives read
  access to exactly one R2 object for at most 5 minutes. This is acceptable
  for music streaming where the browser needs to fetch the bytes anyway.
- The Access Key ID is visible in the presigned URL's `X-Amz-Credential`
  query param. This is by design (S3 presigned URLs always expose it) — the
  Access Key ID alone cannot authenticate, only the paired secret can sign.
- Do **not** set `R2_ACCOUNT_ID` in `wrangler.toml` `[vars]` — it would be
  public in the bundle. Always use a secret.

---

## Secret hygiene checklist

- [ ] Never commit a real secret value into the repo (this file is fine — it
      only documents names).
- [ ] Use a different `WORK_UPLOAD_HMAC_KEY` per environment (dev / staging /
      prod). Never share keys across environments.
- [ ] Rotate at the first sign of leakage (e.g. accidental log capture,
      revoked operator).
- [ ] After rotation, watch the worker logs for a brief uptick in
      `sig mismatch` reasons — that's the in-flight token tail draining.
