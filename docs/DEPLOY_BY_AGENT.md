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

By the end of this runbook: a live EdgeSonic Worker on the operator's Cloudflare account, an R2
subscription active and a bucket bound (R2 is the primary music storage and is **required** —
the deploy will fail without it), D1 schema applied, one working superadmin login, and a clear
list of optional secrets left for the operator to configure themselves.

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

### 2.1 Mandatory prerequisite — R2 subscription

EdgeSonic uses Cloudflare R2 as its primary music storage — the Worker won't deploy without an
R2 bucket bound, and `wrangler r2 bucket create` returns `403 / 10051` if the account has no R2
subscription. R2 subscription is free to add (free tier: 10 GB storage + free egress; subscribing
by itself incurs no charge). Before you proceed, **verify R2 is enabled** and have the operator
complete the checkout if not:

1. Ask the operator to open `dash.cloudflare.com/<account-id>/r2/overview` and click **Purchase
   R2 Plan** (no payment required for the free tier).
2. Once subscribed, verify with:
   ```bash
   npx wrangler r2 bucket list
   ```
   A successful (even if empty) response confirms R2 is active. A 403 / "R2 is not enabled" error
   means the operator hasn't completed checkout — stop and retry after they have.

### 2.2 Clarification questions

1. **Which Cloudflare account** to deploy to, if `wrangler whoami` lists more than one. Never pick
   one silently.
2. **The project/Worker name** (this becomes the D1/R2 resource name prefix too). Default
   suggestion: `edgesonic`.
3. **The domain to bind**, if any. Either a custom domain the operator already controls in that
   account's Cloudflare zone, or explicitly "none" to fall back to
   `<worker-name>.<account>.workers.dev`. Do not try to enumerate zones yourself — `wrangler` has
   no zone-listing command; just ask.
4. **Whether to configure the optional Cloudflare API token now** (`CF_API_TOKEN` + the R2
   presign key pair + Images Transformations, step 3.5). This unlocks the in-app Cloudflare
   integration (cron management, analytics panel), R2 presigned direct streaming (advanced
   redirect / bandwidth optimization), and on-demand cover thumbnailing via the Cloudflare Images
   binding — but every base feature (streaming, library management, tag editing, ...) works
   fully without it, and setting it up means extra manual clicking in the Cloudflare dashboard.
   "No, skip it for now" is a completely valid answer — it can be added later per `SECRETS.md`.
5. **Whether to enable the server-side transcode container (Sandbox DO + ffmpeg)** — this is the
   `[[containers]]` / `Sandbox` Durable Object in `wrangler.toml.example`. It needs **Workers
   Paid** plan ($5/mo base) and Docker running locally at deploy time. If the operator is on the
   Free plan or has no Docker, **keep** the default `--containers-rollout=none` in step 3.6
   (container build is skipped, the `transcode_engine` feature string stays
   `browser_pool` / `disabled` — in-Worker browser-pool transcoding still works without it). Only
   drop the flag if they explicitly want server-side ffmpeg and meet both prerequisites.

Hold onto all five answers — they're used throughout step 3.

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

R2 subscription was already verified in §2.1 — `wrangler r2 bucket create` should now succeed.
If it still returns `403 / 10051`, the operator hasn't completed the R2 checkout; pause and send
them back to `dash.cloudflare.com/<account-id>/r2/overview` → **Purchase R2 Plan**.

Use names derived from the project name confirmed in §2.2 (default `edgesonic-db` /
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

`CF_API_TOKEN` and the R2 S3 key pair (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) all come from
**one** Custom Token the operator creates in the dashboard (you cannot do the clicking yourself).
Only proceed to step 3.5 if the operator opted in when you asked in step 2; otherwise skip
straight to step 3.6.

### 3.5 Optional: single Custom Token → `CF_API_TOKEN` + R2 keys + Images Transformations

Skip this section entirely if the operator declined in step 2.

#### 3.5.1 Create one Custom Token

Open `https://dash.cloudflare.com/<account-id>/api-tokens/create` (use the account id from step 2)
and start a **Custom Token**. A single token can carry multiple permission groups, each with its
own resource scope — add **both** groups below, do **not** create two separate tokens:

- **Permission group 1 — Workers (Account scope)**: add **Workers CI**, **Workers Containers**,
  **Workers Observability**, and **Workers Scripts** (choose *Edit* where offered).
- **Permission group 2 — R2 (Bucket scope)**: add **Workers R2 Storage Bucket Item Read** and scope
  it to the bucket from step 3.2 (`<project-name>-music`).

Continue to summary → **Create Token**. Cloudflare then shows **three** values on the final page,
each shown only once:

| Cloudflare shows | Write to this secret |
|---|---|
| Token value (Bearer string, top of the page) | `CF_API_TOKEN` |
| Access Key ID | `R2_ACCESS_KEY_ID` |
| Secret Access Key | `R2_SECRET_ACCESS_KEY` |

The Access Key ID is the token id and the Secret Access Key is the SHA-256 of the token value —
both are derived from the same token, so one creation gives you all three. Copy all three
immediately; the Secret Access Key is never shown again.

#### 3.5.2 Verify before pushing

A typo'd paste silently breaks cron / analytics / presign until someone notices — verify first:

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

R2 presigned streaming currently signs the default `edgesonic-music` bucket. Leave it disabled
when using a differently named bucket.

#### 3.5.3 Enable Cloudflare Images Transformations (cover thumbnails)

`wrangler.toml.example` binds `[images] binding = "IMAGES"` — this is the Cloudflare Images binding
that `getCoverArt` (`worker/src/endpoints/subsonic/media.ts`) uses to resize cover art on demand
into the `ALLOWED_COVER_SIZES` buckets (64 / 96 / 128 / 192 / 256 / 384 / 512) and cache each
(cover, size, format) in R2. The binding deploys regardless, but **transformations only execute
when Images Transformations is enabled**; otherwise the handler catches the error and falls back
to the original bytes (`X-EdgeSonic-Cover-Cache: bypass`), which works but wastes bandwidth and
re-transforms on every request.

Pick the path that matches step 2's domain answer:

- **Custom domain (a zone is bound)** — dashboard:
  `https://dash.cloudflare.com/<account-id>/images/transformations` → select the zone → **Enable
  transformations**. This is the normal path and the only one that needs the zone-level toggle.
  Optional API fallback (requires the same `CF_API_TOKEN`):
  ```bash
  # Replace <zone-id> with the zone id from dash.cloudflare.com/?to=/:account/zones
  curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone-id>/settings/image_resizing" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"value":"on"}'
  ```
- **`*.workers.dev` only (no zone)** — skip the zone toggle entirely; the Images binding works
  directly on the Worker's account. Nothing to click.

**Cost note** — Images Transformations bill per *unique* (source image, params) combination per
calendar month; repeats inside the same month are free. `getCoverArt` caches each result in R2
under `<coverKey>_s<size>.<ext>`, so the billable count is roughly
`(cover count) × (size buckets used) × (formats negotiated)` once per month. For a typical library
of a few thousand covers × 7 sizes × 3 formats, the upper bound is in the low tens of thousands per
month — check current pricing at `https://developers.cloudflare.com/images/pricing/`.

### 3.6 Deploy

```bash
VERSION=$(date +%s)
# Default (Sandbox container disabled — matches step 2 item 5 = no):
wrangler deploy --config wrangler.toml --containers-rollout=none --var WORKER_VERSION:"$VERSION"

# Only if the operator opted into the Sandbox transcoder in step 2 item 5 AND Docker is running:
# wrangler deploy --config wrangler.toml --var WORKER_VERSION:"$VERSION"
```

`--containers-rollout=none` skips building the Sandbox transcoder's Docker image (server-side
ffmpeg transcoding via the `Sandbox` Durable Object). **Default to including it.** Drop the flag
only when **all three** are true: the operator explicitly opted into server-side transcoding in
step 2 item 5, the account is on the **Workers Paid** plan (required — the Free plan cannot run
Containers), and `docker info` succeeds in the current shell. Otherwise the deploy will either
fail at the container build step or the Worker will 1eject the Sandbox DO at runtime. Without
the container, `transcode_engine` should remain `browser_pool` (in-Worker transcoding) or
`disabled` — both work on the Free plan.

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
  they declined, remind them it's still available any time — **one** Custom Token at
  `https://dash.cloudflare.com/<account-id>/api-tokens/create` with both Workers (Account scope)
  and R2 Object Read (Bucket scope, scoped to `<project-name>-music`) permission groups yields all
  three secrets at once (`CF_API_TOKEN` = token value, `R2_ACCESS_KEY_ID` = Access Key ID,
  `R2_SECRET_ACCESS_KEY` = Secret Access Key). Step 3.5 also walks through enabling Cloudflare
  Images Transformations for on-demand cover thumbnailing (recommended — without it `getCoverArt`
  falls back to the original bytes; not required for any other feature). See `SECRETS.md`.
- If the operator opted into the Sandbox transcode container in step 2 item 5, confirm
  `wrangler containers list` shows a healthy instance after the deploy; if they declined, remind
  them `transcode_engine` is already defaulting to `browser_pool` and they can switch to
  `sandbox` later by re-deploying without `--containers-rollout=none` (requires Workers Paid + Docker).
- Once `CF_API_TOKEN` is set, the cron schedule this deploy cleared needs restoring — visit
  **Settings → Cloudflare → "Ensure default cron"** in the app (the default schedule is
  `0 */1 * * *`, hourly).
