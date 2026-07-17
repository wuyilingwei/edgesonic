<img align="right" width="112" src="web/public/logo.svg" alt="EdgeSonic logo" />

# EdgeSonic

[English](README.md) | [简体中文](README.zh-CN.md)

> **If you are an AI agent** asked to deploy this project, stop reading here and follow
> [`docs/DEPLOY_BY_AGENT.md`](docs/DEPLOY_BY_AGENT.md) instead — it's a self-contained runbook
> written specifically for you.

Serverless Subsonic-compatible music streaming server running entirely on **Cloudflare Workers**. No dedicated host, no always-on process — deploy once, stream anywhere.

## What it does

EdgeSonic serves two roles simultaneously:

1. **Subsonic-compatible API server** (v1.16.1 + OpenSubsonic extensions) — works with native clients like DSub, Symfonium, Substreamer, and Sonixd.
2. **Music library management UI** — tag editing, metadata scraping, file organisation, upload/download, and artwork management; feature-equivalent to music-tag-web v1.

## Features

- **Multiple storage backends** — Cloudflare R2 (primary), WebDAV, S3-compatible (MinIO / AWS / Backblaze B2 / Wasabi), external Subsonic upstream, direct URL
- **R2 presigned direct streaming** — optional SigV4 302 redirect so browsers fetch R2 objects directly, bypassing Worker bandwidth limits
- **Browser worker pool** — distributed metadata parsing and transcoding via Web Workers; concurrency is tunable and pauses automatically during playback
- **Server-side transcoding** — Sandbox DO container (ffmpeg) with on-demand or pre-bake strategy; browser pool engine for zero-backend-CPU transcoding
- **Full Subsonic API** — playlists, bookmarks, play queue, annotations (star/rating/scrobble), sharing, internet radio, podcasts, Last.fm integration, now playing, cover art, lyrics
- **Migrate from / push to another Subsonic server** — browser-driven clone pulls metadata, audio bytes, user accounts (with each user's own starred items and playlists), playlists, and stars from an upstream Subsonic-compatible server; resumable via a local browser cache so a cancelled or interrupted run picks up where it left off instead of starting over. The reverse direction pushes local stars/playlists back upstream.
- **Tag editor** — read/write ID3v2 (MP3), VORBIS_COMMENT (FLAC/OGG), batch operations, keyword semantics (`{null}` / `{write}` / `{export}`)
- **Metadata scraping** — NetEase / QQ Music / Kugou public APIs, frontend-driven, results submitted back to the server
- **Incremental WebDAV scanning** — ETag + Last-Modified diff; unchanged files skipped; deduplication key prevents double-dispatch
- **Feature flags** — all major behaviours toggleable at runtime via D1, with 60-second in-isolate memory cache (zero KV cost)
- **Cloudflare API integration** — push Worker secrets, manage cron triggers, and read analytics without redeploying
- **Cross-origin isolation** — COOP/COEP headers for SharedArrayBuffer (required by ffmpeg.wasm)
- **Anti-loop chain** — `esChain` marker prevents A→B→A proxy loops between EdgeSonic instances
- **SPA version detection** — long-lived tabs are prompted to refresh after a Worker deploy

## Quick start

### Deploy (recommended): fork + GitHub Action

No local toolchain required — deploy straight from a fork using the precompiled release:

1. **Fork** this repository to your own GitHub account.
2. **Create a Cloudflare API token** ([dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/?to=/:account/api-tokens) → *Create Token*) with `Workers Scripts:Edit`, `D1:Edit`, and `Workers R2 Storage:Edit`, and note your **Account ID**.
3. In your fork, open **Actions → Deploy EdgeSonic → Run workflow**, paste the token and account ID, choose the **`stable`** or **`prerelease`** channel, and run it.

The workflow downloads the latest precompiled release (prebuilt frontend + Worker — **no build step**), auto-creates any missing D1/KV/R2 resources, and deploys. Full input reference: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Local CLI deploy (development)

Prefer to build and deploy from your own machine (e.g. while developing)? Use the Wrangler CLI flow below.

### Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A Cloudflare account with:
  - **D1** database (`edgesonic-db`)
  - **R2** bucket (`edgesonic-music`)
  - **KV** namespace (legacy binding, kept for schema compat)

### 1. Clone and configure

```bash
git clone https://github.com/your-org/edgesonic.git
cd edgesonic
cp worker/wrangler.toml.example worker/wrangler.toml
# Edit worker/wrangler.toml — fill in account_id, database_id, KV id, INSTANCE_ID, domain
```

`worker/wrangler.toml` is **gitignored** — it contains private resource IDs and must never be committed.

### 2. Initialise the database

```bash
# Create the database (first time only)
cd worker
npx wrangler d1 create edgesonic-db

# Apply schema
npx wrangler d1 execute edgesonic-db --remote --file migrations/Schema.sql
```

### 3. Push secrets

See `worker/SECRETS.md` for details. At minimum:

```bash
cd worker
npx wrangler secret put WORK_UPLOAD_HMAC_KEY  # random 48-byte base64
```

Optional (enable R2 presigned direct streaming):

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Cloudflare integration (cron management, analytics):

```bash
# Set via the Settings UI after first deploy, or:
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

### 4. Deploy

```bash
./deploy.sh
```

The script builds the Vue frontend, bundles it with the Worker via `[assets]`, and deploys. After deploy, restore the cron trigger:

> **Settings → Cloudflare → "Ensure default cron"**

(Wrangler deploy clears dynamic cron schedules — see `worker/CF_CRON.md`.)

### First login

Navigate to your Worker domain. The default admin account is created on first access — see the login page for instructions, or create one directly:

```bash
npx wrangler d1 execute edgesonic-db --remote --command \
  "INSERT INTO users (username, master_password, level) VALUES ('admin', hex(sha256('yourpassword')), 3)"
```

## Documentation

The technical reference lives under [`docs/`](docs/):

| Doc | Covers |
|-----|--------|
| [`DEPLOY_BY_AGENT.md`](docs/DEPLOY_BY_AGENT.md) | Self-contained deploy runbook for AI coding agents — precompiled release package, no local build |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Monorepo layout, storage backend model, adding an S3-compatible source |
| [`DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Dev servers, type-checking, running tests, applying the DB schema |
| [`DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Recommended fork + GitHub Action deploy (downloads a precompiled release, no build), Cloudflare resource requirements / free-tier limits |
| [`SECURITY.md`](docs/SECURITY.md) | What never to commit, where secrets live, anti-loop chain |
| [`DESIGN.md`](docs/DESIGN.md) | Full backend/frontend design: auth model, capability matrix, adapter interfaces (Chinese) |
| [`cf-integration.md`](docs/cf-integration.md) | Cloudflare API integration internals (token/cron/analytics without redeploying) |
| [`external-transcoder.md`](docs/external-transcoder.md) | Running the external ffmpeg transcoder container |

## Licence

[MIT](LICENSE)
