// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R2 version-aware demo library restore. Uses the Worker's MUSIC_BUCKET R2
// binding (not the S3 API) so no extra credentials are required. The
// binding exposes:
//   - bucket.list({ include: ["httpMetadata", "customMetadata"] })
//   - bucket.get(key, { versionId })  — read a specific historical version
//   - bucket.put(key, body)           — write bytes as the new current
//
// Flow:
//   1. recordDemoLibrarySnapshot(): superadmin-triggered. Lists every key
//      under demo-library/ with versioning info, captures each key's
//      current versionId into a D1 kv_store JSON blob.
//   2. restoreDemoLibrarySnapshot(): called by the periodic demo reset. For
//      each recorded key, fetches the recorded versionId bytes and PUTs them
//      back as a fresh current version — wiping any visitor modification.
//      Keys that no longer exist in the snapshot are left alone (a future
//      enhancement can DELETE them to fully match the snapshot).
//
// Prerequisite: R2 bucket versioning must be enabled on the demo bucket
// (the deploy-demo workflow runs `wrangler r2 bucket versioning enable`
// on first deploy).

const SNAPSHOT_KV_KEY = "demo:library_snapshot";

interface Snapshot {
  recordedAt: string;
  // Map of R2 key → versionId captured at snapshot time
  versions: Record<string, string>;
}

export interface SnapshotResult {
  ok: boolean;
  recorded?: number;
  restored?: number;
  skipped?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Record current versionId of every key under demo-library/.
// ---------------------------------------------------------------------------
export async function recordDemoLibrarySnapshot(env: Env): Promise<SnapshotResult> {
  const bucket = env.MUSIC_BUCKET;
  const snapshot: Snapshot = { recordedAt: new Date().toISOString(), versions: {} };
  let cursor: string | undefined;
  let recorded = 0;
  do {
    const listed = await bucket.list({ cursor, limit: 1000, prefix: "demo-library/" });
    // R2ListResult.objects each have a `versionId` when bucket versioning is
    // enabled. The workers-types may not expose it on the type but R2 returns
    // it; read defensively.
    for (const obj of listed.objects as Array<{ key: string; versionId?: string; size: number; etag?: string; httpMetadata?: unknown; customMetadata?: unknown }>) {
      if (obj.versionId) {
        snapshot.versions[obj.key] = obj.versionId;
        recorded++;
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  } while (cursor);

  await env.DB
    .prepare(
      "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(SNAPSHOT_KV_KEY, JSON.stringify(snapshot), Math.floor(Date.now() / 1000))
    .run();

  return { ok: true, recorded };
}

// ---------------------------------------------------------------------------
// Restore every key under demo-library/ to the versionId captured by the
// last recordDemoLibrarySnapshot call. For each recorded key:
//   1. bucket.get(key, { versionId }) — fetch the snapshot-time bytes
//   2. bucket.put(key, body)           — write them as the new current
// This effectively rolls back any visitor modification while preserving
// the historical version trail.
// ---------------------------------------------------------------------------
export async function restoreDemoLibrarySnapshot(env: Env): Promise<SnapshotResult> {
  const bucket = env.MUSIC_BUCKET;
  const row = await env.DB
    .prepare("SELECT value FROM kv_store WHERE key = ?")
    .bind(SNAPSHOT_KV_KEY)
    .first<{ value: string }>();
  if (!row) return { ok: true, restored: 0, skipped: 0 };
  let snapshot: Snapshot;
  try { snapshot = JSON.parse(row.value) as Snapshot; }
  catch { return { ok: false, restored: 0, skipped: 0, error: "Invalid snapshot JSON" }; }

  let restored = 0;
  let skipped = 0;
  for (const [key, versionId] of Object.entries(snapshot.versions)) {
    try {
      const obj = await bucket.get(key, { versionId } as never);
      if (!obj) { skipped++; continue; }
      // `bucket.get` with versionId returns an R2ObjectBody when the version
      // still exists. Cast defensively — workers-types narrows the union to
      // R2Object | R2ObjectBody and only the body variant exposes arrayBuffer.
      const body = await (obj as R2ObjectBody).arrayBuffer();
      const httpMetadata = (obj as unknown as { httpMetadata?: R2HTTPMetadata }).httpMetadata;
      const customMetadata = (obj as unknown as { customMetadata?: Record<string, string> }).customMetadata;
      await bucket.put(key, body, { httpMetadata, customMetadata });
      restored++;
    } catch (e) {
      console.error(`[demoRestore] failed to restore ${key}@${versionId}:`, e);
      skipped++;
    }
  }
  return { ok: true, restored, skipped };
}