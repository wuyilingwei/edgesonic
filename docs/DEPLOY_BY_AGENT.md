# Deploy EdgeSonic — Agent Runbook

> **If you are an AI coding agent** reading this repository in order to
> deploy EdgeSonic, this document is written for you. Treat each numbered section below as an
> executable procedure, not background reading. Do not skip the clarification step — guessing an
> account, project name, or domain on the operator's behalf is the most common way this goes
> wrong.
>
> This is the **agent-run, local `wrangler`** deployment path. It downloads a precompiled package
> from GitHub Releases so you never need to run `npm ci` / `npm run build:web` yourself. If you
> want the alternative human/CI-driven path instead, see [`DEPLOYMENT.md`](DEPLOYMENT.md).
>
> This document itself is written in English, but every step where you talk to the operator —
> clarifying questions in step 2, the completion report in step 5, any error you surface — should
> be in whatever language the operator has been using in your conversation. Don't default to
> English just because this file is in English.

## 0. What you'll produce

By the end of this runbook: a live EdgeSonic Worker on the operator's Cloudflare account, D1
schema applied, R2 bucket bound, one working superadmin login, and a clear list of optional
secrets left for the operator to configure themselves.

## 1. Ensure `wrangler` is available

```bash
command -v wrangler || npm install -g wrangler
wrangler --version
```

If the install fails (no npm, no network, permission error), stop and report the exact error to
the operator — do not attempt sudo escalation without asking first.

## 2. Authenticate and clarify the deployment target

```bash
wrangler whoami
```

If this fails or shows no login, run `wrangler login` and wait — this opens a browser OAuth flow
that only the operator can complete. Do not attempt to script around it.

Once logged in, `wrangler whoami` prints a table of every Cloudflare account the token can act
on. **Before creating anything**, use an interactive clarification tool (e.g. `AskUserQuestion`)
— or, if none is available, ask in plain text and wait for a reply — to confirm:

1. **Which Cloudflare account** to deploy to, if `wrangler whoami` lists more than one. Never pick
   one silently.
2. **The project/Worker name** (this becomes the D1/R2 resource name prefix too). Default
   suggestion: `edgesonic`.
3. **The domain to bind**, if any. Either a custom domain the operator already controls in that
   account's Cloudflare zone, or explicitly "none" to fall back to
   `<worker-name>.<account>.workers.dev`. Do not try to enumerate zones yourself — `wrangler` has
   no zone-listing command; just ask.
4. **Whether to configure the optional Cloudflare API token now** (`CF_API_TOKEN` + the R2
   presign key pair, step 3.5). This unlocks the in-app Cloudflare integration (cron management,
   analytics panel) and R2 presigned direct streaming (advanced redirect / bandwidth
   optimization) — but every base feature (streaming, library management, tag editing, ...) works
   fully without it, and setting it up means extra manual clicking in the Cloudflare dashboard.
   "No, skip it for now" is a completely valid answer — it can be added later per `SECRETS.md`.

Hold onto all four answers — they're used throughout step 3.

## 3. Download the precompiled release and deploy

### 3.1 Fetch the latest package

```bash
curl -s https://api.github.com/repos/wuyilingwei/edgesonic/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*edgesonic-release.tar.gz"' \
  | cut -d'"' -f4 > /tmp/edgesonic-release-url.txt

curl -L -o edgesonic-release.tar.gz "$(cat /tmp/edgesonic-release-url.txt)"
tar xzf edgesonic-release.tar.gz
cd edgesonic-release
```

This package (built by `.github/workflows/release.yml`) already contains a built `web/dist` and
an isolated `worker/node_modules` (just `hono` + `@cloudflare/sandbox`) — there is nothing left to
compile. If no release exists yet, tell the operator the release pipeline hasn't been run and
stop (do not fall back to cloning the source repo and building locally without asking first —
that changes the trust/tooling assumptions of this runbook).

### 3.2 Create Cloudflare resources

Use names derived from the project name confirmed in step 2 (default `edgesonic-db` /
`edgesonic-music` if the operator kept the `edgesonic` default):

```bash
cd worker
wrangler d1 create <project-name>-db          # note the printed database_id
wrangler r2 bucket create <project-name>-music
```

D1/R2 are the only resources that need explicit creation. The Durable Object binding (Sandbox
transcoder container) is declarative — it's already in `wrangler.toml.example`'s
`[[durable_objects.bindings]]` / `[[migrations]]` blocks and activates automatically on first
`wrangler deploy`, no separate step needed.

### 3.3 Fill in `wrangler.toml`

```bash
cp wrangler.toml.example wrangler.toml
```

Replace these placeholders in `wrangler.toml` with the values gathered above:

| Placeholder | Value |
|---|---|
| `name = "edgesonic"` | project name from step 2 |
| `<YOUR_CLOUDFLARE_ACCOUNT_ID>` | account id from step 2's `wrangler whoami` |
| `<YOUR_D1_DATABASE_ID>` | `database_id` printed by `wrangler d1 create` |
| `<YOUR_R2_BUCKET_NAME>` | the R2 bucket name you just created |
| `<GENERATE_A_UUID>` | a fresh UUID, e.g. `uuidgen` (this is `INSTANCE_ID`, the anti-loop marker) |
| `<your-domain.example.com>` in the `routes` block | the domain from step 2, **or delete the entire `routes = [...]` block** if the operator chose no custom domain |

### 3.4 Apply the schema and required secret

```bash
wrangler d1 execute <project-name>-db --remote --config wrangler.toml --file migrations/Schema.sql

openssl rand -base64 48 | wrangler secret put WORK_UPLOAD_HMAC_KEY --config wrangler.toml
printf '%s' "<account-id-from-step-2>" | wrangler secret put CF_ACCOUNT_ID --config wrangler.toml
```

`WORK_UPLOAD_HMAC_KEY` is the HMAC-SHA-256 signing key for browser-pool transcode upload tokens
(`SECRETS.md` §1) — one of two secrets this runbook can push without any operator action.
`CF_ACCOUNT_ID` is the other: it's the exact same account id already confirmed in step 2, so just
reuse it — don't ask the operator for it again.

`CF_API_TOKEN` and the R2 S3 key pair (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) are different —
they require credentials only the operator can mint in the dashboard. Only proceed to step 3.5 if
the operator opted in when you asked in step 2; otherwise skip straight to step 3.6.

### 3.5 Optional: `CF_API_TOKEN` + R2 keys

Skip this section entirely if the operator declined in step 2.

These come from **two separate** credentials the operator creates in the dashboard (you cannot do
the clicking yourself). Give them this exact walkthrough:

**Token 1 — Workers API token → `CF_API_TOKEN`**

1. Open `https://dash.cloudflare.com/<account-id>/api-tokens/create` (use the account id from
   step 2) and start a **Custom Token**.
2. In the permissions search box, add the Workers permission groups — **Workers CI**, **Workers
   Containers**, **Workers Observability**, and **Workers Scripts** (choose *Edit* where offered).
   Do **not** add R2 here.
3. Continue to summary → **Create Token** and copy the Bearer token string (shown once). That value
   is `CF_API_TOKEN`.

**Token 2 — R2 API token → `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`**

1. Open **R2 → Manage R2 API Tokens** (`https://dash.cloudflare.com/<account-id>/r2/api-tokens`) and
    create a token scoped to the bucket from step 3.2 with **Object Read**.
2. On creation Cloudflare shows an **Access Key ID** and a **Secret Access Key** for the
   S3-compatible endpoint — copy both (shown once). Those are `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY`.

Once the operator pastes those three values back to you, **verify them before pushing anything** —
a typo'd paste silently breaks cron/analytics/presign until someone notices:

```bash
# Verify the Bearer token
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CF_API_TOKEN" | grep -q '"success":true' \
  && echo "CF_API_TOKEN OK" || echo "CF_API_TOKEN INVALID — ask the operator to recheck/re-paste"

# Verify the R2 key pair (curl's built-in SigV4 signer, curl >=7.75)
curl -s -o /dev/null -w '%{http_code}\n' \
  --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
  --aws-sigv4 "aws:amz:auto:s3" \
  "https://<account-id>.r2.cloudflarestorage.com/<project-name>-music"
# expect 200 — anything else means the key pair or bucket name is wrong
```

Only once both checks pass, push the three secrets:

```bash
wrangler secret put CF_API_TOKEN --config wrangler.toml
wrangler secret put R2_ACCESS_KEY_ID --config wrangler.toml
wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.toml
```

After `CF_API_TOKEN` is set, also flip `enable_r2_presign` on (see `SECRETS.md` §3) and restore the
cron schedule the deploy in step 3.6 clears — see step 5.

R2 presigned streaming currently signs the default `edgesonic-music` bucket. Leave it disabled when using a differently named bucket.

### 3.6 Deploy

```bash
VERSION=$(date +%s)
wrangler deploy --config wrangler.toml --containers-rollout=none --var WORKER_VERSION:"$VERSION"
```

`--containers-rollout=none` skips building the Sandbox transcoder's Docker image (server-side
ffmpeg transcoding) — most agent environments don't have Docker available. If the operator
specifically wants that feature and has Docker running, this flag can be dropped, but default to
including it.

`wrangler deploy` clears any existing cron schedule on the Worker. Restoring it requires a
`CF_API_TOKEN`, which the operator hasn't provided yet at this point in the runbook — don't try to
work around that. Just tell them in step 5 to visit **Settings → Cloudflare → "Ensure default
cron"** once they've set that secret (see `CF_CRON.md`).

## 4. Create the superadmin account

Generate a random 10-character password and write it straight into D1 — there is no
auto-provisioned first-run admin in this codebase, this INSERT is the only way an account exists:

```bash
ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 10)"

wrangler d1 execute <project-name>-db --remote --config wrangler.toml --command \
  "INSERT INTO users (username, master_password, level, enabled) VALUES ('admin', hex(sha256('${ADMIN_PASSWORD}')), 3, 1)"
```

`level = 3` is the superadmin tier (full permission matrix, the only level that can manage other
admins). Keep `$ADMIN_PASSWORD` in your final report to the operator only — never write it into a
committed file, a log an operator didn't ask for, or anywhere else it could persist.

## 5. Report completion to the operator

Tell the operator, in the language they've been using in this conversation (default to English
if unclear):

- The Worker is live at `https://<name>.<account>.workers.dev` (or their custom domain).
- Superadmin login: username `admin`, password `<the generated 10-character password>` — shown
  once, save it now.
- This runbook already pushed `WORK_UPLOAD_HMAC_KEY` and `CF_ACCOUNT_ID` automatically — nothing
  to do there.
- If the operator opted into the optional API tokens in step 2, it's already handled (step 3.5). If
  they declined, remind them it's still available any time — two Cloudflare tokens (a Workers API
  token for `CF_API_TOKEN`, plus a separate R2 API token for `R2_ACCESS_KEY_ID` +
  `R2_SECRET_ACCESS_KEY`; dashboard links + exact click-through in step 3.5) enable the in-app
  Cloudflare integration (cron management, analytics) and R2 presigned direct streaming (bypasses
  Worker bandwidth limits) — see `SECRETS.md`.
- Once `CF_API_TOKEN` is set, the cron schedule this deploy cleared needs restoring — visit
  **Settings → Cloudflare → "Ensure default cron"** in the app (the default schedule is
  `0 */1 * * *`, hourly).
