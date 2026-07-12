# Development

Local dev workflow, type-checking, running tests, and applying database migrations outside of a full deploy.

## Commands

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
