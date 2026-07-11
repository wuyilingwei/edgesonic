// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// instance lands on path 2 (UPDATE + tag_scanned=0). Default scans should
// still skip unchanged files (the 051 behaviour).
//
// We drive asyncScanSource directly with a stub D1 + a stub `listWebdav`
// indirection isn't exposed, so we instead use the public exports and a
// purpose-built WebDAV mock via fetch override. The contract under test is
// behavioural: with `etagCheck=false` (which `force=1` triggers in the
// HTTP handler), an UNCHANGED file still gets an UPDATE.
//
// Run: npx tsx test/scan_force_rescan.test.ts

import { asyncScanSource } from "../worker/src/endpoints/storage/scan";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

interface InstanceRow {
  id: string;
  master_id: string;
  source_id: string;
  storage_uri: string;
  suffix: string;
  content_type: string | null;
  size: number;
  source_etag: string | null;
  source_last_modified: number | null;
  tag_scanned: number;
  updated_at: number;
}

interface MockState {
  instances: InstanceRow[];
  updates: Array<{ id: string; tag_scanned: number }>;
  scanJobs: Array<{ id: string; status: string; total_items: number; scanned_items: number; ended_at: number | null; error_message: string | null }>;
  // ad-hoc table for storage_sources.last_sync update
  lastSyncUpdates: number;
}

function makeDb(state: MockState): unknown {
  const prepare = (sql: string) => {
    const args: unknown[] = [];
    const stmt = {
      bind(...rest: unknown[]) { args.push(...rest); return stmt; },
      async first<T>(): Promise<T | null> {
        if (/FROM song_instances WHERE id = \?/i.test(sql)) {
          const id = args[0] as string;
          return (state.instances.find((r) => r.id === id) ?? null) as T | null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (/FROM song_instances WHERE source_id = \?/i.test(sql)) {
          // The query in scan.ts: SELECT id, storage_uri, source_etag, source_last_modified, size, tag_scanned
          const sid = args[0] as string;
          const rows = state.instances.filter((r) => r.source_id === sid).map((r) => ({
            id: r.id,
            storage_uri: r.storage_uri,
            source_etag: r.source_etag,
            source_last_modified: r.source_last_modified,
            size: r.size,
            tag_scanned: r.tag_scanned,
          }));
          return { results: rows as T[] };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT INTO scan_jobs/i.test(sql)) {
          state.scanJobs.push({
            id: args[0] as string,
            status: "running",
            total_items: 0,
            scanned_items: 0,
            ended_at: null,
            error_message: null,
          });
        } else if (/UPDATE scan_jobs/i.test(sql)) {
          // last arg is jobId
          const jobId = args[args.length - 1] as string;
          const job = state.scanJobs.find((j) => j.id === jobId);
          if (job) {
            // Best effort: detect status/totals from the SQL shape
            if (/status = \?/i.test(sql)) job.status = args[0] as string;
          }
        } else if (/UPDATE song_instances/i.test(sql)) {
          // bind order in scan.ts UPDATE:
          //  etag, lm, size, contentType, suffix, now, id
          const id = args[args.length - 1] as string;
          state.updates.push({ id, tag_scanned: 0 });
          const row = state.instances.find((r) => r.id === id);
          if (row) {
            row.tag_scanned = 0;
            row.source_etag = (args[0] as string | null);
            row.source_last_modified = (args[1] as number | null);
            row.size = args[2] as number;
          }
        } else if (/UPDATE storage_sources SET last_sync/i.test(sql)) {
          state.lastSyncUpdates++;
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prepare, batch: async (s: any[]) => Promise.all(s.map((x) => x.run())) };
}

// PROPFIND response that lists exactly one unchanged file. Etag/lm/size match
// the seed row in the mock so default scans skip; force scans update.
function buildPropfindBody(): string {
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/Artist/Album/track.mp3</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>1000</d:getcontentlength>
      <d:getcontenttype>audio/mpeg</d:getcontenttype>
      <d:getetag>"abc123"</d:getetag>
      <d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;
}

function installFetchMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (_url: string, _init?: RequestInit) => {
    return new Response(buildPropfindBody(), {
      status: 207,
      headers: { "Content-Type": "application/xml" },
    });
  };
}

function seedInstance(uri: string): InstanceRow {
  // Match Mon, 01 Jan 2024 00:00:00 GMT → 1704067200
  const lm = Math.floor(Date.parse("Mon, 01 Jan 2024 00:00:00 GMT") / 1000);
  return {
    id: "si-existing",
    master_id: "sm-1",
    source_id: "src-1",
    storage_uri: uri,
    suffix: "mp3",
    content_type: "audio/mpeg",
    size: 1000,
    source_etag: "abc123",
    source_last_modified: lm,
    tag_scanned: 1, // important: 1 so the default-skip path does NOT auto-dispatch
    updated_at: 0,
  };
}

async function main() {
  installFetchMock();
  const SRC = { id: "src-1", base_url: "https://dav.example.com/dav", username: "u", password: "p", root_path: "" };
  const uri = `webdav://${SRC.id}/Artist/Album/track.mp3`;

  console.log("default scan (etagCheck=true): unchanged file → SKIP (no UPDATE):");
  {
    const state: MockState = { instances: [seedInstance(uri)], updates: [], scanJobs: [], lastSyncUpdates: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await asyncScanSource(makeDb(state) as any, SRC, "sj-default", { etagCheck: true });
    assert(state.updates.length === 0, "no UPDATE issued for unchanged row");
    const row = state.instances[0];
    assert(row.tag_scanned === 1, "tag_scanned NOT reset (still 1)");
  }

  console.log("\nforce scan (etagCheck=false): unchanged file → UPDATE + tag_scanned=0:");
  {
    const state: MockState = { instances: [seedInstance(uri)], updates: [], scanJobs: [], lastSyncUpdates: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await asyncScanSource(makeDb(state) as any, SRC, "sj-force", { etagCheck: false });
    assert(state.updates.length === 1, `exactly 1 UPDATE issued (got ${state.updates.length})`);
    assert(state.updates[0].id === "si-existing", "UPDATE targets the existing instance");
    const row = state.instances[0];
    assert(row.tag_scanned === 0, "tag_scanned reset to 0 (browser pool will re-read tags)");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
