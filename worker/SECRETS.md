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
| `STORAGE_KEY` | 068 | AES-256-GCM master key for `storage_sources.password_encrypted`. 32 bytes / 64 hex chars. | Yes |

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

## 2. `STORAGE_KEY` (task 068)

### Why

WebDAV / Subsonic upstream credentials used to sit in `storage_sources.password`
as plaintext, which meant any D1 reader (CF dashboard SELECT, accidental backup
download, a leaked operator token) could see them. Task 068 introduces a new
`password_encrypted` column whose contents are AES-256-GCM blobs of the form
`v1:<base64url(nonce(12) || ciphertext || tag(16))>`. `STORAGE_KEY` is the
master key those blobs are sealed under.

When the secret is **unset or empty**, the worker keeps writing plaintext into
the legacy `password` column so existing deployments keep working — and the
`/storage/sources/migratePasswords` endpoint refuses to run. After you push
the secret, all new add/update flows route through `encryptPassword()` and the
migrate endpoint can sweep the legacy rows.

### How to set

```bash
# 64 hex chars = 32 random bytes — AES-256 key material
openssl rand -hex 32 | pbcopy        # macOS clipboard
# or just: openssl rand -hex 32

cd worker
wrangler secret put STORAGE_KEY      # paste the value on stdin
```

Verify:

```bash
wrangler secret list
# expect: STORAGE_KEY  Secret
```

### One-time migration (recommended right after setting the secret)

From the Settings → Storage Sources page, an admin clicks
"Migrate plaintext passwords". The endpoint
`POST /storage/sources/migratePasswords` walks every row with
`password_encrypted IS NULL AND password <> ''`, rewrites it to
`password_encrypted = encryptPassword(password)`, clears the legacy column,
and returns `{ migrated, failed, total }`. The button is super-admin only.

### Rotation (out of scope for v1)

Rotating `STORAGE_KEY` would invalidate every existing `v1:` blob. A future
task will handle envelope-style rotation; for now treat the key as effectively
permanent. **Make a copy when you generate it.**

### Length / entropy

- Exactly 64 hex chars (32 bytes raw). `parseHexKey()` rejects anything else.
- Generate with `openssl rand -hex 32` — 256 bits is the standard AES-256 key
  size.
- Do **not** reuse `WORK_UPLOAD_HMAC_KEY` or `CF_API_TOKEN` here; they live in
  separate trust domains.

---

## 3. `CF_API_TOKEN` / `CF_ACCOUNT_ID` (task 054)

These are managed through the Settings UI → "Cloudflare 集成" sub-block. See
the docstring in `worker/src/endpoints/edgesonic/cf.ts` and the inline notes in
`worker/src/types/env.d.ts` for the full flow. They are listed here only so
operators have a single inventory of all secrets the worker reads.

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
