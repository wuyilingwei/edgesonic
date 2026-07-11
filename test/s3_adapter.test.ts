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
// Coverage:
//  1. parseS3RootPath: bucket-only / bucket/prefix / deep prefix
//  2. buildAuthorizationHeader (sigv4.ts): header format, credential, signed headers, signature
//  3. listS3Objects: 2-object XML; empty list; truncated with NextContinuationToken
//  4. createS3Adapter().stream(): 200; 206 range; 404 → body:null
//  5. createS3Adapter().put(): PUT method + required headers
//  6. getS3Config: s3 source row → S3Config; missing/disabled → null
//  7. asyncScanS3Source: creates song_instances + work_queue rows with correct dedupKey
//
// Run: cd worker && npm test -- --reporter=verbose 2>&1 | grep s3_adapter

import { DatabaseSync } from "node:sqlite";
import { parseS3RootPath, createS3Adapter, listS3Objects } from "../worker/src/adapters/s3";
import { buildAuthorizationHeader } from "../worker/src/utils/sigv4";
import { getS3Config } from "../worker/src/adapters/index";
import { asyncScanS3Source } from "../worker/src/endpoints/storage/scan";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// D1 shim (reused from r2_presign.test.ts pattern)
// ---------------------------------------------------------------------------
function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        return (stmt.get(...boundArgs) ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number((info as any).changes ?? 0) } };
      },
    };
  }
  return {
    prepare,
    async batch(stmts: any[]) {
      const results = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  };
}

function buildFullDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE storage_sources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL, username TEXT, password TEXT,
      password_encrypted TEXT, presign_username TEXT, presign_password TEXT,
      root_path TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT 'us-east-1',
      last_sync INTEGER, enabled INTEGER DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'library',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      image_r2_key TEXT, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT,
      year INTEGER, genre TEXT, cover_r2_key TEXT,
      song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_masters (
      id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL,
      album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT,
      track INTEGER, disc INTEGER, duration INTEGER, genre TEXT,
      compilation INTEGER DEFAULT 0, participants TEXT, lyrics TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE song_instances (
      id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT,
      source_type TEXT DEFAULT 'original', source_dedup_key TEXT,
      parent_instance_id TEXT, storage_uri TEXT NOT NULL,
      transcode_profile TEXT, suffix TEXT NOT NULL DEFAULT '',
      content_type TEXT, bit_rate INTEGER, sample_rate INTEGER,
      bit_depth INTEGER, channels INTEGER, duration INTEGER,
      size INTEGER, missing INTEGER DEFAULT 0,
      tag_scanned INTEGER NOT NULL DEFAULT 0,
      source_etag TEXT, source_last_modified INTEGER,
      expires_at INTEGER, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE scan_jobs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      total_items INTEGER NOT NULL DEFAULT 0,
      scanned_items INTEGER NOT NULL DEFAULT 0,
      error_message TEXT, started_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER
    );
    CREATE TABLE work_queue (
      id TEXT PRIMARY KEY, task_type TEXT NOT NULL, payload TEXT NOT NULL,
      required_caps TEXT, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_by TEXT, claimed_at INTEGER, heartbeat_at INTEGER,
      result_json TEXT, error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER
    );
  `);
  return sqlite;
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------
type FetchFn = typeof globalThis.fetch;
const originalFetch = globalThis.fetch;

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return handler(req);
  };
}

function restoreFetch() {
  (globalThis as any).fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// S3 XML helpers for tests
// ---------------------------------------------------------------------------
function makeListXml(objects: Array<{ key: string; size: number; etag: string; lastModified: string }>, nextToken?: string): string {
  const contents = objects.map((o) => `
    <Contents>
      <Key>${o.key}</Key>
      <Size>${o.size}</Size>
      <ETag>"${o.etag}"</ETag>
      <LastModified>${o.lastModified}</LastModified>
    </Contents>`).join("\n");

  const truncated = nextToken ? "<IsTruncated>true</IsTruncated>" : "<IsTruncated>false</IsTruncated>";
  const nextTokenEl = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>testbucket</Name>
  <Prefix></Prefix>
  <MaxKeys>1000</MaxKeys>
  ${truncated}
  ${contents}
  ${nextTokenEl}
</ListBucketResult>`;
}

const S3CONFIG = {
  endpoint: "https://minio.example.com:9000",
  bucket: "testbucket",
  prefix: "",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  // 1. parseS3RootPath
  // =========================================================================
  console.log("parseS3RootPath: bucket-only");
  {
    const { bucket, prefix } = parseS3RootPath("mybucket");
    assert(bucket === "mybucket", `bucket = "mybucket" (got "${bucket}")`);
    assert(prefix === "", `prefix = "" (got "${prefix}")`);
  }

  console.log("\nparseS3RootPath: bucket/prefix");
  {
    const { bucket, prefix } = parseS3RootPath("mybucket/music");
    assert(bucket === "mybucket", `bucket = "mybucket" (got "${bucket}")`);
    assert(prefix === "music", `prefix = "music" (got "${prefix}")`);
  }

  console.log("\nparseS3RootPath: bucket/deep/prefix");
  {
    const { bucket, prefix } = parseS3RootPath("mybucket/path/to/music");
    assert(bucket === "mybucket", `bucket = "mybucket"`);
    assert(prefix === "path/to/music", `prefix = "path/to/music" (got "${prefix}")`);
  }

  console.log("\nparseS3RootPath: empty string");
  {
    const { bucket, prefix } = parseS3RootPath("");
    assert(bucket === "", `bucket = "" for empty root_path`);
    assert(prefix === "", `prefix = "" for empty root_path`);
  }

  // =========================================================================
  // 2. buildAuthorizationHeader (sigv4.ts)
  // =========================================================================
  console.log("\nbuildAuthorizationHeader: format verification");
  {
    const url = new URL("https://minio.example.com:9000/testbucket/music/track.flac");
    const result = await buildAuthorizationHeader({
      method: "GET",
      url,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
      payloadHash: "UNSIGNED-PAYLOAD",
    });

    assert(result.authorization.startsWith("AWS4-HMAC-SHA256 "), "Authorization starts with AWS4-HMAC-SHA256");
    assert(result.authorization.includes("Credential=AKIAIOSFODNN7EXAMPLE/"), "Credential contains accessKeyId");
    assert(result.authorization.includes("/us-east-1/s3/aws4_request"), "Credential scope: region/service/terminator");
    assert(result.authorization.includes("SignedHeaders="), "SignedHeaders present");
    assert(result.authorization.includes("host"), "host in SignedHeaders");
    assert(result.authorization.includes("x-amz-date"), "x-amz-date in SignedHeaders");
    assert(result.authorization.includes("Signature="), "Signature present");
    assert(/Signature=[0-9a-f]{64}/.test(result.authorization), "Signature is 64-char hex");
    assert(result.amzDate.length === 16, `amzDate length 16 (got ${result.amzDate.length})`);
    assert(/^\d{8}T\d{6}Z$/.test(result.amzDate), `amzDate format YYYYMMDDTHHMMSSZ (got "${result.amzDate}")`);
    assert(result.contentSha256 === "UNSIGNED-PAYLOAD", `contentSha256 = UNSIGNED-PAYLOAD (got "${result.contentSha256}")`);
  }

  console.log("\nbuildAuthorizationHeader: extraHeaders signed");
  {
    const url = new URL("https://minio.example.com:9000/testbucket/track.flac");
    const result = await buildAuthorizationHeader({
      method: "GET",
      url,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
      payloadHash: "UNSIGNED-PAYLOAD",
      extraHeaders: { range: "bytes=0-1023" },
    });
    assert(result.authorization.includes("range"), "range in SignedHeaders when extraHeaders provided");
  }

  // =========================================================================
  // 3. listS3Objects
  // =========================================================================
  console.log("\nlistS3Objects: 2 objects, no pagination");
  {
    let capturedUrl = "";
    let capturedAuthHeader = "";
    mockFetch((req) => {
      capturedUrl = req.url;
      capturedAuthHeader = req.headers.get("Authorization") || "";
      const xml = makeListXml([
        { key: "music/Artist/Album/01 Track.flac", size: 45000000, etag: "abc123", lastModified: "2024-01-15T10:00:00.000Z" },
        { key: "music/Artist/Album/02 Track.mp3", size: 8000000, etag: "def456", lastModified: "2024-01-15T10:01:00.000Z" },
      ]);
      return new Response(xml, { status: 200 });
    });

    const result = await listS3Objects(S3CONFIG);
    restoreFetch();

    assert(result.objects.length === 2, `2 objects (got ${result.objects.length})`);
    assert(result.nextToken === null, "nextToken null when not truncated");
    assert(result.objects[0].key === "music/Artist/Album/01 Track.flac", `first key correct`);
    assert(result.objects[0].size === 45000000, `first size correct`);
    assert(result.objects[0].etag === "abc123", `ETag unquoted (got "${result.objects[0].etag}")`);
    assert(result.objects[0].lastModified !== null, "lastModified parsed");
    assert(result.objects[1].key === "music/Artist/Album/02 Track.mp3", "second key correct");
    assert(capturedUrl.includes("list-type=2"), "list-type=2 in query string");
    assert(capturedUrl.includes("testbucket"), "bucket in URL");
    assert(capturedAuthHeader.startsWith("AWS4-HMAC-SHA256"), "Authorization header present");
  }

  console.log("\nlistS3Objects: empty list");
  {
    mockFetch(() => new Response(makeListXml([]), { status: 200 }));
    const result = await listS3Objects(S3CONFIG);
    restoreFetch();
    assert(result.objects.length === 0, "empty list returns 0 objects");
    assert(result.nextToken === null, "nextToken null for empty list");
  }

  console.log("\nlistS3Objects: truncated with NextContinuationToken");
  {
    mockFetch(() => new Response(makeListXml(
      [{ key: "music/track1.flac", size: 1000, etag: "aaa", lastModified: "2024-01-01T00:00:00Z" }],
      "token-abc-123",
    ), { status: 200 }));

    const result = await listS3Objects(S3CONFIG);
    restoreFetch();
    assert(result.objects.length === 1, "1 object in truncated response");
    assert(result.nextToken === "token-abc-123", `nextToken = "token-abc-123" (got "${result.nextToken}")`);
  }

  console.log("\nlistS3Objects: prefix in query when config.prefix set");
  {
    let capturedUrl = "";
    mockFetch((req) => {
      capturedUrl = req.url;
      return new Response(makeListXml([]), { status: 200 });
    });
    const configWithPrefix = { ...S3CONFIG, prefix: "music" };
    await listS3Objects(configWithPrefix);
    restoreFetch();
    assert(capturedUrl.includes("prefix=music"), `prefix param in URL (url=${capturedUrl})`);
  }

  // =========================================================================
  // 4. createS3Adapter().stream()
  // =========================================================================
  console.log("\nstream: 200 OK response");
  {
    mockFetch(() => new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("AUDIO")); c.close(); } }),
      { status: 200, headers: { "Content-Type": "audio/flac", "Content-Length": "5" } },
    ));

    const adapter = createS3Adapter(S3CONFIG);
    const result = await adapter.stream("s3://src1/music/Artist/Album/track.flac");
    restoreFetch();

    assert(result.statusCode === 200, `statusCode 200 (got ${result.statusCode})`);
    assert(result.body !== null, "body present on 200");
    assert(result.contentType === "audio/flac", `contentType audio/flac (got "${result.contentType}")`);
    assert(result.contentLength === 5, `contentLength 5 (got ${result.contentLength})`);
    assert(result.acceptRanges === true, "acceptRanges true");
  }

  console.log("\nstream: 206 Partial Content with Range");
  {
    let capturedRangeHeader = "";
    let capturedAuthHeader = "";
    mockFetch((req) => {
      capturedRangeHeader = req.headers.get("Range") || "";
      capturedAuthHeader = req.headers.get("Authorization") || "";
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("CHUNK")); c.close(); } }),
        {
          status: 206,
          headers: {
            "Content-Type": "audio/flac",
            "Content-Range": "bytes 0-1023/45000000",
            "Content-Length": "1024",
          },
        },
      );
    });

    const adapter = createS3Adapter(S3CONFIG);
    const result = await adapter.stream("s3://src1/music/track.flac", "bytes=0-1023");
    restoreFetch();

    assert(result.statusCode === 206, `statusCode 206 (got ${result.statusCode})`);
    assert(result.body !== null, "body present on 206");
    assert(capturedRangeHeader === "bytes=0-1023", `Range header forwarded (got "${capturedRangeHeader}")`);
    assert(capturedAuthHeader.includes("range"), "range signed in Authorization (in SignedHeaders)");
    assert(result.contentRange === "bytes 0-1023/45000000", `contentRange set (got "${result.contentRange}")`);
  }

  console.log("\nstream: 404 → body:null");
  {
    mockFetch(() => new Response("NoSuchKey", { status: 404 }));
    const adapter = createS3Adapter(S3CONFIG);
    const result = await adapter.stream("s3://src1/missing/track.flac");
    restoreFetch();
    assert(result.body === null, "body null on 404");
    assert(result.statusCode === 404, `statusCode 404 (got ${result.statusCode})`);
  }

  // =========================================================================
  // 5. createS3Adapter().put()
  // =========================================================================
  console.log("\nput: correct method and headers");
  {
    let capturedMethod = "";
    let capturedAuth = "";
    let capturedContentType = "";
    let capturedAmzDate = "";
    mockFetch((req) => {
      capturedMethod = req.method;
      capturedAuth = req.headers.get("Authorization") || "";
      capturedContentType = req.headers.get("Content-Type") || "";
      capturedAmzDate = req.headers.get("x-amz-date") || "";
      return new Response(null, { status: 200 });
    });

    const adapter = createS3Adapter(S3CONFIG);
    await adapter.put!(
      "s3://src1/music/track.flac",
      new TextEncoder().encode("FLAC_BYTES"),
      "audio/flac",
    );
    restoreFetch();

    assert(capturedMethod === "PUT", `method PUT (got "${capturedMethod}")`);
    assert(capturedAuth.startsWith("AWS4-HMAC-SHA256"), "Authorization header present on PUT");
    assert(capturedContentType === "audio/flac", `Content-Type audio/flac (got "${capturedContentType}")`);
    assert(capturedAmzDate.length === 16, `x-amz-date present (got "${capturedAmzDate}")`);
  }

  console.log("\nput: throws on non-200 response");
  {
    mockFetch(() => new Response("AccessDenied", { status: 403 }));
    const adapter = createS3Adapter(S3CONFIG);
    let threw = false;
    try {
      await adapter.put!("s3://src1/track.flac", new Uint8Array(0));
    } catch {
      threw = true;
    }
    restoreFetch();
    assert(threw, "put() throws on 403 response");
  }

  // =========================================================================
  // 6. getS3Config
  // =========================================================================
  console.log("\ngetS3Config: returns S3Config for valid s3 source");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-1', 's3', 'MinIO', 'https://minio.example.com:9000', 'ACCESS_KEY', 'SECRET_KEY', 'mybucket/music', 'us-east-1', 1);
    `);
    const db = makeD1(sqlite);

    const config = await getS3Config(db, "s3-1");
    assert(config !== null, "config is not null for valid source");
    assert(config!.endpoint === "https://minio.example.com:9000", `endpoint correct (got "${config!.endpoint}")`);
    assert(config!.bucket === "mybucket", `bucket correct (got "${config!.bucket}")`);
    assert(config!.prefix === "music", `prefix correct (got "${config!.prefix}")`);
    assert(config!.accessKeyId === "ACCESS_KEY", `accessKeyId correct`);
    assert(config!.secretAccessKey === "SECRET_KEY", `secretAccessKey correct`);
    assert(config!.region === "us-east-1", `region correct`);
  }

  console.log("\ngetS3Config: null for missing source");
  {
    const sqlite = buildFullDb();
    const db = makeD1(sqlite);
    const config = await getS3Config(db, "nonexistent");
    assert(config === null, "null for missing source");
  }

  console.log("\ngetS3Config: null for disabled source");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-disabled', 's3', 'Disabled', 'https://minio.example.com:9000', 'AK', 'SK', 'bucket', 'us-east-1', 0);
    `);
    const db = makeD1(sqlite);
    const config = await getS3Config(db, "s3-disabled");
    assert(config === null, "null for disabled source");
  }

  console.log("\ngetS3Config: null for non-s3 type");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('wd-1', 'webdav', 'WD', 'https://dav.example.com', 'user', 'pass', '/music', 'us-east-1', 1);
    `);
    const db = makeD1(sqlite);
    const config = await getS3Config(db, "wd-1");
    assert(config === null, "null for webdav type source");
  }

  console.log("\ngetS3Config: trailing slash stripped from endpoint");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-2', 's3', 'R2', 'https://minio.example.com:9000/', 'AK', 'SK', 'bucket', 'auto', 1);
    `);
    const db = makeD1(sqlite);
    const config = await getS3Config(db, "s3-2");
    assert(config!.endpoint === "https://minio.example.com:9000", `trailing slash stripped (got "${config!.endpoint}")`);
    assert(config!.region === "auto", `region = auto`);
  }

  // =========================================================================
  // 7. asyncScanS3Source: song_instances + work_queue with correct dedupKey
  // =========================================================================
  console.log("\nasyncScanS3Source: inserts song_instances and work_queue rows");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-scan', 's3', 'Test', 'https://minio.example.com:9000', 'AK', 'SK', 'testbucket', 'us-east-1', 1);
      INSERT INTO scan_jobs (id, source_id, status, started_at)
      VALUES ('sj-test', 's3-scan', 'running', 0);
    `);

    // Mock fetch for ListObjectsV2 — return 2 audio files
    mockFetch(() => new Response(makeListXml([
      { key: "Artist One/Album A/01 Track One.flac", size: 40000000, etag: "etag1", lastModified: "2024-01-01T00:00:00Z" },
      { key: "Artist One/Album A/02 Track Two.mp3", size: 8000000, etag: "etag2", lastModified: "2024-01-01T00:01:00Z" },
    ]), { status: 200 }));

    const src = {
      id: "s3-scan",
      base_url: "https://minio.example.com:9000",
      username: "AK",
      password: "SK",
      root_path: "testbucket",
      region: "us-east-1",
      mode: "library",
    };

    const fakeEnv = {} as any;
    await asyncScanS3Source(fakeEnv, makeD1(sqlite), src, "sj-test", {
      etagCheck: true,
      dispatchToWorkerPool: true,
    });
    restoreFetch();

    // Verify song_instances were created
    const instances = sqlite.prepare("SELECT * FROM song_instances ORDER BY storage_uri").all() as any[];
    assert(instances.length === 2, `2 song_instances created (got ${instances.length})`);

    const flacInst = instances.find((r: any) => r.storage_uri.endsWith(".flac"));
    assert(flacInst !== undefined, "flac instance found");
    assert(
      flacInst.storage_uri === "s3://s3-scan/Artist One/Album A/01 Track One.flac",
      `storage_uri format correct (got "${flacInst?.storage_uri}")`,
    );
    assert(flacInst.suffix === "flac", `suffix = flac (got "${flacInst?.suffix}")`);
    assert(flacInst.source_id === "s3-scan", `source_id correct`);

    const mp3Inst = instances.find((r: any) => r.storage_uri.endsWith(".mp3"));
    assert(mp3Inst !== undefined, "mp3 instance found");
    assert(
      mp3Inst.storage_uri === "s3://s3-scan/Artist One/Album A/02 Track Two.mp3",
      `mp3 storage_uri correct`,
    );

    // Verify work_queue rows — dedup is embedded in the ID: wt-metadata-<instanceId>
    // (see dispatchWorkBatch: id = `wt-${taskType}-${dedupKey}` when dedupKey set)
    const workRows = sqlite.prepare("SELECT * FROM work_queue ORDER BY id").all() as any[];
    assert(workRows.length === 2, `2 work_queue rows (got ${workRows.length})`);
    for (const row of workRows as any[]) {
      assert(row.task_type === "metadata", `task_type = metadata (got "${row.task_type}")`);
      // Row id = "wt-metadata-<instanceId>" — verify prefix pattern
      assert(row.id.startsWith("wt-metadata-si-"), `row.id starts with wt-metadata-si- (got "${row.id}")`);
      // The dedupKey is the instanceId — extract from id and compare to payload
      const embeddedInstanceId = row.id.replace(/^wt-metadata-/, "");
      const payload = JSON.parse(row.payload);
      assert(payload.instanceId === embeddedInstanceId, `payload.instanceId="${payload.instanceId}" matches embeddedInstanceId="${embeddedInstanceId}"`);
      assert(payload.sourceUri.startsWith("s3://s3-scan/"), `sourceUri has s3:// scheme`);
    }

    // Verify scan_jobs updated to completed
    const job = sqlite.prepare("SELECT status FROM scan_jobs WHERE id = 'sj-test'").get() as any;
    assert(job?.status === "completed", `scan_job status = completed (got "${job?.status}")`);
  }

  console.log("\nasyncScanS3Source: skips unchanged files (etagCheck=true)");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-s2', 's3', 'T', 'https://minio.example.com:9000', 'A', 'S', 'bucket', 'us-east-1', 1);
      INSERT INTO scan_jobs (id, source_id, status, started_at) VALUES ('sj2', 's3-s2', 'running', 0);
    `);

    // Pre-create an existing instance with matching etag/size/lastModified
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-x', 'Unknown Artist');
      INSERT INTO albums (id, name) VALUES ('al-x', 'Unknown Album');
      INSERT INTO song_masters (id, album_id, artist_id, title) VALUES ('sm-existing', 'al-x', 'ar-x', 'Track');
      INSERT INTO song_instances (id, master_id, source_id, storage_uri, suffix, size, source_etag, source_last_modified, tag_scanned)
      VALUES ('si-existing', 'sm-existing', 's3-s2', 's3://s3-s2/music/track.flac', 'flac', 5000000, 'etag-match', ${Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000)}, 1);
    `);

    mockFetch(() => new Response(makeListXml([
      { key: "music/track.flac", size: 5000000, etag: "etag-match", lastModified: "2024-01-01T00:00:00Z" },
    ]), { status: 200 }));

    const src2 = { id: "s3-s2", base_url: "https://minio.example.com:9000", username: "A", password: "S", root_path: "bucket", region: "us-east-1", mode: "library" };
    await asyncScanS3Source({} as any, makeD1(sqlite), src2, "sj2", { etagCheck: true, dispatchToWorkerPool: false });
    restoreFetch();

    // Should NOT have created a new instance (unchanged file skipped)
    const count = (sqlite.prepare("SELECT COUNT(*) as n FROM song_instances").get() as any).n;
    assert(count === 1, `only 1 instance (existing not duplicated), got ${count}`);
  }

  console.log("\nasyncScanS3Source: sync_only mode skips DB inserts");
  {
    const sqlite = buildFullDb();
    sqlite.exec(`
      INSERT INTO storage_sources (id, type, name, base_url, username, password, root_path, region, enabled)
      VALUES ('s3-s3', 's3', 'T', 'https://minio.example.com:9000', 'A', 'S', 'bucket', 'us-east-1', 1);
      INSERT INTO scan_jobs (id, source_id, status, started_at) VALUES ('sj3', 's3-s3', 'running', 0);
    `);
    mockFetch(() => new Response(makeListXml([
      { key: "track.flac", size: 1000, etag: "x", lastModified: "2024-01-01T00:00:00Z" },
    ]), { status: 200 }));

    const src3 = { id: "s3-s3", base_url: "https://minio.example.com:9000", username: "A", password: "S", root_path: "bucket", region: "us-east-1", mode: "sync_only" };
    await asyncScanS3Source({} as any, makeD1(sqlite), src3, "sj3", {});
    restoreFetch();

    const count = (sqlite.prepare("SELECT COUNT(*) as n FROM song_instances").get() as any).n;
    assert(count === 0, `0 instances for sync_only source (got ${count})`);
  }

  // =========================================================================
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  } else {
    console.log("\nALL PASS");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
