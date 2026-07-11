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

//
// Validates the four decision branches in asyncScanSource:
//   1. unchanged file      → no UPDATE / no INSERT, only tag_scanned stays
//   2. etag changed        → UPDATE with tag_scanned reset to 0
//   3. size changed        → UPDATE with tag_scanned reset to 0
//   4. new file            → INSERT chain
//
// Also asserts parseMultistatus picks up getetag + getlastmodified.
// Run: npx tsx test/incremental_scan.test.ts

import { asyncScanSource, parseMultistatus } from "../worker/src/endpoints/storage/scan";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

declare global { type D1Database = unknown; type Env = unknown; }

// ----------------------------------------------------------------------------
// Mock D1 database — captures every SQL written + supports the read paths
// asyncScanSource hits during a scan.
// ----------------------------------------------------------------------------
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
  scanJobs: Array<{
    id: string;
    source_id: string;
    status: string;
    total_items: number;
    scanned_items: number;
    error_message: string | null;
    started_at: number;
    ended_at: number | null;
  }>;
  inserts: number;
  updates: number;
  artistInserts: number;
  albumInserts: number;
  masterInserts: number;
  sourceUpdates: number;
  albumRecalcs: number;
}

function makeDb(initial: InstanceRow[]): { db: unknown; state: MockState } {
  const state: MockState = {
    instances: initial.slice(),
    scanJobs: [],
    inserts: 0,
    updates: 0,
    artistInserts: 0,
    albumInserts: 0,
    masterInserts: 0,
    sourceUpdates: 0,
    albumRecalcs: 0,
  };

  function makeStmt(sql: string, binds: unknown[] = []): unknown {
    const trimmed = sql.trim().replace(/\s+/g, " ");
    const stmt = {
      bind(...args: unknown[]) { return makeStmt(sql, args); },
      async run() {
        if (trimmed.startsWith("INSERT INTO scan_jobs")) {
          state.scanJobs.push({
            id: binds[0] as string,
            source_id: binds[1] as string,
            status: "running",
            total_items: 0,
            scanned_items: 0,
            error_message: null,
            started_at: binds[2] as number,
            ended_at: null,
          });
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE scan_jobs SET")) {
          // ignore — we don't assert on these
          return { success: true };
        }
        if (trimmed.startsWith("INSERT OR IGNORE INTO artists")) {
          state.artistInserts++;
          return { success: true };
        }
        if (trimmed.startsWith("INSERT OR IGNORE INTO albums")) {
          state.albumInserts++;
          return { success: true };
        }
        if (trimmed.startsWith("INSERT OR IGNORE INTO song_masters")) {
          state.masterInserts++;
          return { success: true };
        }
        if (trimmed.startsWith("INSERT OR IGNORE INTO song_instances")) {
          state.inserts++;
          state.instances.push({
            id: binds[0] as string,
            master_id: binds[1] as string,
            source_id: binds[2] as string,
            storage_uri: binds[3] as string,
            suffix: binds[4] as string,
            content_type: binds[5] as string | null,
            size: binds[6] as number,
            source_etag: binds[7] as string | null,
            source_last_modified: binds[8] as number | null,
            tag_scanned: 0,
            updated_at: binds[10] as number,
          });
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE song_instances SET source_etag")) {
          state.updates++;
          const id = binds[binds.length - 1] as string;
          const row = state.instances.find((r) => r.id === id);
          if (row) {
            row.source_etag = binds[0] as string | null;
            row.source_last_modified = binds[1] as number | null;
            row.size = binds[2] as number;
            row.content_type = binds[3] as string | null;
            row.suffix = binds[4] as string;
            row.tag_scanned = 0;
            row.updated_at = binds[5] as number;
          }
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE albums SET")) {
          state.albumRecalcs++;
          return { success: true };
        }
        if (trimmed.startsWith("UPDATE storage_sources SET last_sync")) {
          state.sourceUpdates++;
          return { success: true };
        }
        throw new Error(`unmocked run sql: ${trimmed}`);
      },
      async all<T = unknown>() {
        if (trimmed.startsWith("SELECT id, storage_uri, source_etag")) {
          // SELECT ... FROM song_instances WHERE source_id = ?
          const sourceId = binds[0] as string;
          return {
            results: state.instances
              .filter((r) => r.source_id === sourceId)
              .map((r) => ({
                id: r.id,
                storage_uri: r.storage_uri,
                source_etag: r.source_etag,
                source_last_modified: r.source_last_modified,
                size: r.size,
                tag_scanned: r.tag_scanned,
              })) as unknown as T[],
          };
        }
        throw new Error(`unmocked all sql: ${trimmed}`);
      },
      async first<T = unknown>() { return null as unknown as T; },
    };
    return stmt;
  }

  const db = {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  return { db, state };
}

// ----------------------------------------------------------------------------
// Mock global fetch — returns a Multistatus XML that mirrors the remote tree.
// ----------------------------------------------------------------------------
function multistatusXml(
  basePath: string,
  files: Array<{ path: string; size: number; etag: string | null; lm: string | null }>,
): string {
  const responses = files
    .map((f) => {
      const lmTag = f.lm ? `<d:getlastmodified>${f.lm}</d:getlastmodified>` : "";
      const etagTag = f.etag ? `<d:getetag>"${f.etag}"</d:getetag>` : "";
      return `
<d:response>
  <d:href>${basePath}/${encodeURI(f.path)}</d:href>
  <d:propstat><d:prop>
    <d:resourcetype/>
    <d:getcontentlength>${f.size}</d:getcontentlength>
    <d:getcontenttype>audio/mpeg</d:getcontenttype>
    ${etagTag}
    ${lmTag}
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>`;
    })
    .join("");
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}

function installFetchMock(xml: string) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    return new Response(xml, { status: 207, headers: { "Content-Type": "application/xml" } });
  }) as unknown as typeof fetch;
}

// ----------------------------------------------------------------------------
// 1. parseMultistatus tests
// ----------------------------------------------------------------------------
(async () => {
  console.log("\nparseMultistatus extracts etag + lastModified:");
  const xml = multistatusXml("/dav/music", [
    { path: "song.mp3", size: 1024, etag: "abc-123", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
    { path: "song2.flac", size: 2048, etag: null, lm: null },
  ]);
  const entries = parseMultistatus(xml, "/dav/music");
  const song = entries.find((e) => e.path === "song.mp3");
  const song2 = entries.find((e) => e.path === "song2.flac");
  assert(!!song, "parsed song.mp3");
  assert(song?.etag === "abc-123", "etag stripped of quotes");
  assert(song?.lastModified !== null && song?.lastModified !== undefined, "lastModified parsed");
  assert(song?.size === 1024, "size parsed");
  assert(!!song2, "parsed song2.flac");
  assert(song2?.etag === null, "missing etag → null");
  assert(song2?.lastModified === null, "missing lastModified → null");

  // ---------------------------------------------------------------------------
  // 2. asyncScanSource decision branches
  // ---------------------------------------------------------------------------
  console.log("\nasyncScanSource: unchanged file is skipped:");
  {
    const initial: InstanceRow[] = [
      {
        id: "si-existing", master_id: "sm-existing", source_id: "src-x",
        storage_uri: "webdav://src-x/song.mp3", suffix: "mp3",
        content_type: "audio/mpeg", size: 1024,
        source_etag: "abc-123",
        source_last_modified: Math.floor(Date.parse("Tue, 13 Jun 2026 12:00:00 GMT") / 1000),
        tag_scanned: 1, updated_at: 0,
      },
    ];
    const { db, state } = makeDb(initial);
    installFetchMock(
      multistatusXml("/dav", [
        { path: "song.mp3", size: 1024, etag: "abc-123", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
      ]),
    );
    state.scanJobs.push({
      id: "job-1", source_id: "src-x", status: "running",
      total_items: 0, scanned_items: 0, error_message: null,
      started_at: 0, ended_at: null,
    });
    await asyncScanSource(
      db as unknown as D1Database,
      { id: "src-x", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      "job-1",
      { etagCheck: true },
    );
    assert(state.inserts === 0, "no inserts");
    assert(state.updates === 0, "no updates");
    const row = state.instances[0];
    assert(row.tag_scanned === 1, "tag_scanned preserved on skip");
  }

  console.log("\nasyncScanSource: etag changed → UPDATE + tag_scanned reset:");
  {
    const initial: InstanceRow[] = [
      {
        id: "si-existing", master_id: "sm-existing", source_id: "src-x",
        storage_uri: "webdav://src-x/song.mp3", suffix: "mp3",
        content_type: "audio/mpeg", size: 1024,
        source_etag: "OLD-etag",
        source_last_modified: Math.floor(Date.parse("Tue, 13 Jun 2026 12:00:00 GMT") / 1000),
        tag_scanned: 1, updated_at: 0,
      },
    ];
    const { db, state } = makeDb(initial);
    installFetchMock(
      multistatusXml("/dav", [
        { path: "song.mp3", size: 1024, etag: "NEW-etag", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
      ]),
    );
    state.scanJobs.push({
      id: "job-1", source_id: "src-x", status: "running",
      total_items: 0, scanned_items: 0, error_message: null,
      started_at: 0, ended_at: null,
    });
    await asyncScanSource(
      db as unknown as D1Database,
      { id: "src-x", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      "job-1",
      { etagCheck: true },
    );
    assert(state.updates === 1, "exactly one update");
    assert(state.inserts === 0, "no insert");
    const row = state.instances[0];
    assert(row.source_etag === "NEW-etag", "etag updated");
    assert(row.tag_scanned === 0, "tag_scanned reset to 0");
  }

  console.log("\nasyncScanSource: size changed → UPDATE + tag_scanned reset:");
  {
    const initial: InstanceRow[] = [
      {
        id: "si-existing", master_id: "sm-existing", source_id: "src-x",
        storage_uri: "webdav://src-x/song.mp3", suffix: "mp3",
        content_type: "audio/mpeg", size: 1024,
        source_etag: "abc-123",
        source_last_modified: Math.floor(Date.parse("Tue, 13 Jun 2026 12:00:00 GMT") / 1000),
        tag_scanned: 1, updated_at: 0,
      },
    ];
    const { db, state } = makeDb(initial);
    installFetchMock(
      multistatusXml("/dav", [
        // etag + lm same, but size bumped from 1024 to 9999
        { path: "song.mp3", size: 9999, etag: "abc-123", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
      ]),
    );
    state.scanJobs.push({
      id: "job-1", source_id: "src-x", status: "running",
      total_items: 0, scanned_items: 0, error_message: null,
      started_at: 0, ended_at: null,
    });
    await asyncScanSource(
      db as unknown as D1Database,
      { id: "src-x", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      "job-1",
      { etagCheck: true },
    );
    assert(state.updates === 1, "one update on size mismatch");
    const row = state.instances[0];
    assert(row.size === 9999, "size updated");
    assert(row.tag_scanned === 0, "tag_scanned reset on size change");
  }

  console.log("\nasyncScanSource: brand new file → INSERT chain:");
  {
    const { db, state } = makeDb([]);
    installFetchMock(
      multistatusXml("/dav", [
        { path: "new/song.mp3", size: 8192, etag: "fresh-etag", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
      ]),
    );
    state.scanJobs.push({
      id: "job-1", source_id: "src-new", status: "running",
      total_items: 0, scanned_items: 0, error_message: null,
      started_at: 0, ended_at: null,
    });
    await asyncScanSource(
      db as unknown as D1Database,
      { id: "src-new", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      "job-1",
      { etagCheck: true },
    );
    assert(state.inserts === 1, "one instance inserted");
    assert(state.updates === 0, "no updates");
    assert(state.masterInserts === 1, "master inserted");
    assert(state.albumInserts === 1, "album inserted");
    assert(state.artistInserts === 1, "artist inserted");
    const row = state.instances[0];
    assert(row.source_etag === "fresh-etag", "etag stored on insert");
    assert(row.source_last_modified !== null, "lastModified stored");
    assert(row.size === 8192, "size stored");
  }

  console.log("\nasyncScanSource: etagCheck=false forces UPDATE even when unchanged:");
  {
    const initial: InstanceRow[] = [
      {
        id: "si-existing", master_id: "sm-existing", source_id: "src-x",
        storage_uri: "webdav://src-x/song.mp3", suffix: "mp3",
        content_type: "audio/mpeg", size: 1024,
        source_etag: "abc-123",
        source_last_modified: Math.floor(Date.parse("Tue, 13 Jun 2026 12:00:00 GMT") / 1000),
        tag_scanned: 1, updated_at: 0,
      },
    ];
    const { db, state } = makeDb(initial);
    installFetchMock(
      multistatusXml("/dav", [
        { path: "song.mp3", size: 1024, etag: "abc-123", lm: "Tue, 13 Jun 2026 12:00:00 GMT" },
      ]),
    );
    state.scanJobs.push({
      id: "job-1", source_id: "src-x", status: "running",
      total_items: 0, scanned_items: 0, error_message: null,
      started_at: 0, ended_at: null,
    });
    await asyncScanSource(
      db as unknown as D1Database,
      { id: "src-x", base_url: "http://dav.example.com/dav", username: "u", password: "p", root_path: null },
      "job-1",
      { etagCheck: false },
    );
    assert(state.updates === 1, "one update when etag check disabled");
    const row = state.instances[0];
    assert(row.tag_scanned === 0, "tag_scanned reset under etagCheck=false");
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
