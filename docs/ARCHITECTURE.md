# Architecture Reference

Project layout, storage backend model, and how to add a new storage source. For the full backend/frontend design rationale (auth model, capability matrix, adapter interfaces), see [`DESIGN.md`](DESIGN.md).

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
│   │   └── Schema.sql    # Single-file schema — the single source of truth (idempotent; no incremental patches)
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
├── docs/                 # This file, DESIGN.md, DEVELOPMENT.md, DEPLOYMENT.md, SECURITY.md, cf-integration.md, external-transcoder.md
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
