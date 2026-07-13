# Deployment

The **recommended** way to deploy EdgeSonic: fork this repository and run the GitHub Action, which deploys a **precompiled release** onto your Cloudflare account — no local toolchain, no build step. The local `./deploy.sh` CLI flow (see the main [README](../README.md#local-cli-deploy-development)) stays available for development.

> Deploying via an AI agent instead of a human? See [`DEPLOY_BY_AGENT.md`](DEPLOY_BY_AGENT.md) — it drives the same precompiled release package from a local `wrangler`, so the agent never has to run a build.

## CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` is **manual-only** (no automatic push trigger). Instead of building from source, it **downloads a precompiled release package** (prebuilt `web/dist` + isolated `worker/node_modules`) published by `.github/workflows/release.yml`, then deploys it with `wrangler`. All credentials are supplied as workflow inputs each time — the repository itself stores nothing.

D1 databases, KV namespaces, and R2 buckets that do not yet exist are **automatically created and bound** during the run.

### Prerequisites

1. **Fork** this repository (deploys run from your fork's Actions tab).
2. A **Cloudflare API token** ([dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create Token*) with `Workers Scripts:Edit`, `D1:Edit`, and `Workers R2 Storage:Edit`, plus your **Account ID**.

No local Node.js or Wrangler install is needed — everything runs on the GitHub-hosted runner.

### How to deploy

Go to **Actions → Deploy EdgeSonic → Run workflow** and fill in:

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `cf_api_token` | ✅ | — | CF API token (Workers:Edit + D1:Edit + R2:Edit) |
| `cf_account_id` | ✅ | — | Cloudflare Account ID |
| `release_channel` | ✅ | `stable` | Which release to deploy: `stable` (latest non-prerelease) or `prerelease` (latest prerelease) |
| `release_tag` | optional | — | Pin an exact release tag (e.g. `v1.0.0`); overrides `release_channel` when set |
| `source_repo` | optional | `wuyilingwei/edgesonic` | Repo to download the release from. Leave as-is to pull the upstream release; change it only if your fork publishes its own |
| `worker_name` | optional | `edgesonic` | Worker script name |
| `d1_database_name` | optional | `edgesonic-db` | D1 database (auto-created if absent) |
| `kv_namespace_name` | optional | `edgesonic-kv` | KV namespace (auto-created if absent) |
| `r2_bucket_name` | optional | `edgesonic-music` | R2 bucket (auto-created if absent) |
| `domain` | optional | — | Custom domain; leave empty for `<worker>.workers.dev` |
| `instance_id` | optional | — | Anti-loop UUID; auto-generated when blank |

The workflow verifies the package checksum (`sha256sum -c`) before extracting, so a corrupted or tampered download fails fast rather than deploying.

### Publishing a release

The deploy action consumes releases produced by `.github/workflows/release.yml`. Push a `v*` tag (e.g. `git tag v1.0.0 && git push origin v1.0.0`) or run **Actions → Release EdgeSonic → Run workflow** with a tag. That job builds the frontend, assembles the self-contained package, and publishes it as a GitHub Release asset — it needs **no** Cloudflare credentials. Mark a release as a *pre-release* on GitHub for it to be picked up by the `prerelease` channel.

### After every deploy

> **Settings → Cloudflare → "Ensure default cron"**

`wrangler deploy` clears dynamic cron schedules. The workflow re-applies the default (`0 */1 * * *`) automatically at the end of the run; if that step reports a warning, visit the admin panel to re-apply them (see `worker/CF_CRON.md`). This applies to CLI deploys (`./deploy.sh`) too.

## Cloudflare resource requirements

| Resource | Purpose | Free tier |
|----------|---------|-----------|
| Workers | Runtime | 100k req/day |
| D1 | Database (all state) | 5 GB storage, 25M row reads/day |
| R2 | Primary music storage | 10 GB storage, free egress |
| KV | Legacy binding (no active reads/writes) | — |

All state uses D1 only (KV writes were removed in task 090). Feature flags, sessions, API keys, rate limits, last.fm cache, now playing, and cron timestamps all live in D1 with a 60-second per-isolate memory cache.
