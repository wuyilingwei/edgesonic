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
| `CF_ACCOUNT_ID` | 054 | Cloudflare account id paired with `CF_API_TOKEN`. Also reused as the R2 account id for 091 presign. | Yes (set via Settings UI) |
| `R2_ACCESS_KEY_ID` | 091 | R2 S3 access key for presigned URL signing. Pair with `R2_SECRET_ACCESS_KEY`. | Yes (to enable presign) |
| `R2_SECRET_ACCESS_KEY` | 091 | R2 S3 secret key for presigned URL signing. | Yes (to enable presign) |

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

## 3. `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (task 091)

### Why

The `/rest/stream` endpoint serves R2 bytes by reading the object inside the
Worker and streaming the body back to the browser. Cloudflare does not
publish a per-sub-request bandwidth limit, but in practice multiple
concurrent sub-requests on the same Worker invocation share an outbound
channel — production observed ~1.2 MB/s when the browser work pool ran 3
metadata fetches alongside the playing stream.

Task 091 adds an optional short-circuit: when `enable_r2_presign` is `'1'`
AND both R2 S3 secrets are set AND `CF_ACCOUNT_ID` is present (already
required by the 054 Cloudflare integration), the stream endpoint signs a
5-minute SigV4 presigned URL and returns a **302 redirect**. The browser
then fetches R2 bytes directly from the R2 S3 endpoint, entirely outside
the Worker sub-request budget. R2 egress is free, so this costs nothing
extra.

When either R2 secret is unset, `CF_ACCOUNT_ID` is absent, or the feature
flag is `'0'`, the endpoint **falls back to the existing in-Worker stream**
— no behaviour change, no error.

### How to create the token

Cloudflare's **Create Token → Custom Token** flow lets a single token carry multiple permission
groups, each with its own resource scope. Create one token with both groups below — do **not**
create two separate tokens:

1. Open `https://dash.cloudflare.com/<account-id>/api-tokens/create` and start a **Custom Token**.
2. **Permission group 1 — Workers (Account scope)**: add **Workers CI**, **Workers Containers**,
   **Workers Observability**, and **Workers Scripts** (choose *Edit* where offered). This is the
   same set required for `CF_API_TOKEN` (task 054).
3. **Permission group 2 — R2 (Bucket scope)**: add **Workers R2 Storage Bucket Item Read** and
   scope it to the `edgesonic-music` bucket (or `*` if you prefer a single token for future
   buckets). Presigned URLs are GET-only, so Object Read is enough — the worker never writes
   through S3.
4. TTL: leave default (no expiry) or set a rotation window.
5. On creation Cloudflare shows **three** values on the final page, each shown only once:
   - **Token value** (Bearer string, top of the page) → `CF_API_TOKEN`
   - **Access Key ID** → `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`

   The Access Key ID is the token id and the Secret Access Key is the SHA-256 of the token value
   — both are derived from the same token, so one creation gives you all three. Copy them
   immediately; the Secret Access Key is never shown again.

### How to set the secrets

```bash
cd worker

# The Bearer token value (same value you'd use for CF_API_TOKEN)
wrangler secret put CF_API_TOKEN
# paste the token value from the dashboard

# The Access Key ID (safe to echo — it's like a username)
wrangler secret put R2_ACCESS_KEY_ID
# paste the Access Key ID from the dashboard

# The Secret Access Key (sensitive — handle like a password)
wrangler secret put R2_SECRET_ACCESS_KEY
# paste the Secret Access Key from the dashboard
```

The R2 account id is **not** a separate secret — the worker reuses
`CF_ACCOUNT_ID` (set via Settings → Cloudflare integration, task 054).
If you haven't pushed `CF_ACCOUNT_ID` yet, the presign path silently falls
back to the in-Worker stream until you do.

Verify:

```bash
wrangler secret list
# expect: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (plus CF_ACCOUNT_ID from 054)
```

### Enabling the feature flag

After pushing the two R2 secrets (and `CF_ACCOUNT_ID`), flip the flag:

```bash
# Via the Settings UI → Presigned URL Direct Stream → enable R2 presign → Save
# Or via D1 directly:
npx wrangler d1 execute edgesonic-db --remote --command \
  "UPDATE feature_strings SET value='1', updated_at=unixepoch() WHERE key='enable_r2_presign'"
```

The in-isolate memory cache has a 60s TTL, so the change takes effect within
a minute without a redeploy.

### Rotation

Rotating the token does **not** invalidate already-issued presigned
URLs until their 5-minute TTL elapses (the signature is computed from the
secret at presign time, not verified against R2's live token list). To rotate:

1. Create a new Custom Token in the dashboard (same permission groups as §3).
2. `wrangler secret put CF_API_TOKEN` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
   with the new values.
3. Wait 5 minutes for outstanding presigned URLs to drain.

### Security notes

- Presigned URLs are **per-object, 5-minute TTL**. A leaked URL gives read
  access to exactly one R2 object for at most 5 minutes. This is acceptable
  for music streaming where the browser needs to fetch the bytes anyway.
- The Access Key ID is visible in the presigned URL's `X-Amz-Credential`
  query param. This is by design (S3 presigned URLs always expose it) — the
  Access Key ID alone cannot authenticate, only the paired secret can sign.
- The Access Key ID is the **token id** and the Secret Access Key is the
  SHA-256 of the token value. Both are derived from the same Custom Token, so
  one token creation gives you `CF_API_TOKEN` + `R2_ACCESS_KEY_ID` +
  `R2_SECRET_ACCESS_KEY` together. See `docs/DEPLOY_BY_AGENT.md` §3.5 for the
  full click-through.

### Enabling Cloudflare Images Transformations (cover thumbnails)

The Cloudflare Images binding (`env.IMAGES`, declared in `wrangler.toml.example`)
is what lets `getCoverArt` resize cover art on demand. The binding deploys
regardless, but **transformations only execute when Images Transformations is
enabled**; otherwise the handler catches the error and falls back to the
original bytes (`X-EdgeSonic-Cover-Cache: bypass`).

- **Custom domain (a zone is bound)** — dashboard:
  `https://dash.cloudflare.com/<account-id>/images/transformations` → select the
  zone → **Enable transformations**. Optional API fallback:
  ```bash
  curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone-id>/settings/image_resizing" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"value":"on"}'
  ```
- **`*.workers.dev` only (no zone)** — skip the zone toggle; the Images binding
  works directly on the Worker's account.

Images Transformations bill per *unique* (source image, params) combination per
calendar month; repeats inside the same month are free. `getCoverArt` caches
each result in R2 under `<coverKey>_s<size>.<ext>`, so the billable count is
roughly `(cover count) × (size buckets used) × (formats negotiated)` once per
month. Check current pricing at
`https://developers.cloudflare.com/images/pricing/`.

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
