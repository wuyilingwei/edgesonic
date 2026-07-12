# EdgeSonic

[English](README.md) | [简体中文](README.zh-CN.md)

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

## Monorepo structure

```
edgesonic/
├── worker/               # Cloudflare Worker (Hono + TypeScript)
│   ├── src/
│   │   ├── adapters/     # StorageAdapter implementations (r2 / webdav / s3 / subsonic / url)
│   │   ├── db/           # D1 query helpers
│   │   ├── endpoints/    # Route handlers grouped by API tier
│   │   │   ├── subsonic/ # Subsonic protocol endpoints (/rest/*)
│   │   │   ├── tag/      # Tag read/write/scrape (/tag/*)
│   │   │   ├── storage/  # Storage source & file management (/storage/*)
│   │   │   └── edgesonic/# Private admin endpoints (/edgesonic/*)
│   │   ├── middleware/   # Auth, CORS, cross-origin isolation
│   │   ├── transcode/    # Engine abstraction (Sandbox / External / BrowserPool)
│   │   ├── utils/        # SigV4, tag I/O, work queue helpers, …
│   │   └── index.ts      # Worker entry point
│   ├── migrations/
│   │   └── Schema.sql    # Single-file schema (fresh install); per-release incremental .sql files alongside
│   ├── wrangler.toml.example   # Sanitised template — copy → wrangler.toml and fill in IDs
│   └── SECRETS.md        # Which Worker Secrets to set and why
│
├── web/                  # Vue 3 SPA (Vite + Pinia + vue-i18n)
│   └── src/
│       ├── views/        # Dashboard / Library / Files / Sources / Settings / …
│       ├── stores/       # Pinia stores (player, workerPool, updateBanner)
│       ├── workers/      # Web Worker (taskExecutor — metadata / transcode)
│       ├── components/   # PlayerBar, UpdateBanner, …
│       └── locales/      # zh-CN / en i18n strings
│
├── test/                 # Plain tsx test scripts (worker) — each file is self-contained, run individually
├── docs/                 # DESIGN.md, cf-integration.md, external-transcoder.md
├── deploy.sh             # Manual deploy script (wrangler CLI, no CF Git integration)
└── package.json          # npm workspaces root (worker + web)
```

## Storage backends

| Type | URI scheme | Scan | Stream | Write |
|------|-----------|------|--------|-------|
| Cloudflare R2 | `r2://<key>` | — (upload directly) | ✅ (proxy or presigned 302) | ✅ |
| WebDAV | `webdav://<sourceId>/<path>` | ✅ PROPFIND | ✅ (proxy or presigned 302) | ✅ |
| S3-compatible | `s3://<sourceId>/<key>` | ✅ ListObjectsV2 | ✅ SigV4 proxy | ✅ |
| Subsonic upstream | `subsonic://<sourceId>/<id>` | ✅ | ✅ proxy | ❌ |
| Direct URL | `url://<url>` | — | ✅ | ❌ |

Source `mode` controls library behaviour:
- `library` (default) — scanned files are added to the music library
- `sync_only` — files are discovered and synced but not added to the library (useful for backup copies)

## Quick start

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

### 5. First login

Navigate to your Worker domain. The default admin account is created on first access — see the login page for instructions, or create one directly:

```bash
npx wrangler d1 execute edgesonic-db --remote --command \
  "INSERT INTO users (username, master_password, level) VALUES ('admin', hex(sha256('yourpassword')), 3)"
```

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

`wrangler deploy` clears dynamic cron schedules. Visit the admin panel after each deploy to re-apply them (see `worker/CF_CRON.md`).

## Development

```bash
npm install              # install all workspaces

# Run worker dev server (Miniflare + local D1/R2)
npm run dev:worker

# Run frontend dev server (Vite HMR)
npm run dev:web

# Type-check worker
npm run typecheck

# Run a single worker test (each file under test/ is self-contained, no
# aggregate runner — see the "Run:" comment at the top of each *.test.ts)
npx tsx test/subsonic/annotation.test.ts

# Run every test file
find test -name '*.test.ts' -exec npx tsx {} \;

# Type-check frontend
cd web && npx vue-tsc --noEmit
```

## Apply a DB migration

```bash
./deploy.sh --migrate worker/migrations/0031_s3_source.sql
```

Or without a full deploy:

```bash
cd worker
npx wrangler d1 execute edgesonic-db --remote --file migrations/0031_s3_source.sql
```

## Adding an S3-compatible storage source

1. Go to **Settings → Storage Sources → Add Source**
2. Choose type **S3 Compatible**
3. Fill in:
   - **Endpoint**: `https://s3.amazonaws.com`, `https://minio.example.com:9000`, `https://<account>.r2.cloudflarestorage.com`, etc.
   - **Access Key ID** / **Secret Access Key**: S3 credentials
   - **Bucket (root path)**: bucket name, or `bucket/prefix`
   - **Region**: `us-east-1` for AWS/MinIO; `auto` for Cloudflare R2
4. Save, then **Scan** to discover music files

Stream requests are proxied through the Worker with SigV4 Authorization headers. Path-style URLs are used universally (`{endpoint}/{bucket}/{key}`), which works with all S3-compatible implementations including MinIO.

## Security notes

- `worker/wrangler.toml` — **never commit** (contains private resource IDs)
- `worker/.wrangler/` — **never commit** (contains local Miniflare SQLite state with real data)
- Secrets go via `wrangler secret put`, never in `wrangler.toml` or source code
- Source passwords (WebDAV / Subsonic) are stored as plaintext in D1 — use database-level access controls and avoid exposing the D1 console to untrusted operators
- Anti-loop chain (`esChain`) prevents infinite proxy loops between EdgeSonic instances; the chain depth is capped by `MAX_PROXY_DEPTH` (default 3)

## Cloudflare resource requirements

| Resource | Purpose | Free tier |
|----------|---------|-----------|
| Workers | Runtime | 100k req/day |
| D1 | Database (all state) | 5 GB storage, 25M row reads/day |
| R2 | Primary music storage | 10 GB storage, free egress |
| KV | Legacy binding (no active reads/writes) | — |

All state uses D1 only (KV writes were removed in task 090). Feature flags, sessions, API keys, rate limits, last.fm cache, now playing, and cron timestamps all live in D1 with a 60-second per-isolate memory cache.

## Licence

[MIT](LICENSE)
