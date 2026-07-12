# Deployment

Alternate deployment path (GitHub Actions instead of the local `./deploy.sh` CLI flow covered in the main [README](../README.md#quick-start)), plus the Cloudflare resource footprint to plan around.

> Deploying via an AI agent instead of a human? See [`DEPLOY_BY_AGENT.md`](DEPLOY_BY_AGENT.md) — it uses a precompiled release package instead of either path below, so the agent never has to run a local build.

## CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` is **manual-only** (no automatic push trigger). All credentials are supplied as workflow inputs each time — the repository itself stores nothing.

D1 databases, KV namespaces, and R2 buckets that do not yet exist are **automatically created and bound** during the run.

### How to deploy

Go to **Actions → Deploy EdgeSonic → Run workflow** and fill in:

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `cf_api_token` | ✅ | — | CF API token (Workers:Edit + D1:Edit + R2:Edit) |
| `cf_account_id` | ✅ | — | Cloudflare Account ID |
| `worker_name` | optional | `edgesonic` | Worker script name |
| `d1_database_name` | optional | `edgesonic-db` | D1 database (auto-created if absent) |
| `kv_namespace_name` | optional | `edgesonic-kv` | KV namespace (auto-created if absent) |
| `r2_bucket_name` | optional | `edgesonic-music` | R2 bucket (auto-created if absent) |
| `domain` | optional | — | Custom domain; leave empty for `<worker>.workers.dev` |
| `instance_id` | optional | — | Anti-loop UUID; auto-generated when blank |

### After every deploy

> **Settings → Cloudflare → "Ensure default cron"**

`wrangler deploy` clears dynamic cron schedules. Visit the admin panel after each deploy to re-apply them (see `worker/CF_CRON.md`). This applies to CLI deploys (`./deploy.sh`) too, not just GitHub Actions.

## Cloudflare resource requirements

| Resource | Purpose | Free tier |
|----------|---------|-----------|
| Workers | Runtime | 100k req/day |
| D1 | Database (all state) | 5 GB storage, 25M row reads/day |
| R2 | Primary music storage | 10 GB storage, free egress |
| KV | Legacy binding (no active reads/writes) | — |

All state uses D1 only (KV writes were removed in task 090). Feature flags, sessions, API keys, rate limits, last.fm cache, now playing, and cron timestamps all live in D1 with a 60-second per-isolate memory cache.
