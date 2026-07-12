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

// Starts two real local HTTP services backed by isolated in-memory D1/R2
// stores. Service A acts as an upstream Subsonic server. Service B uses the
// clone endpoints to call A and pull audio over HTTP.
//
// Run: npx tsx test/internal/two_local_subsonic_services.test.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware, subsonicError } from "../../worker/src/auth";
import { registerRoutes } from "../../worker/src/router";
import { formPostMiddleware } from "../../worker/src/middleware/form_post";
import { formatMiddleware, xmlToJson } from "../../worker/src/middleware/format";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function makeD1(sqlite: DatabaseSync): any {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    let boundArgs: any[] = [];
    return {
      bind(...args: any[]) { boundArgs = args; return this; },
      async first<T = any>(): Promise<T | null> {
        const row = stmt.get(...boundArgs);
        return (row ?? null) as T | null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
        return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.run())) };
}

function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(data); controller.close(); },
  });
}

async function bytesFromBody(body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function makeR2(initial: Record<string, { data: string; contentType: string }> = {}) {
  const map = new Map<string, { data: Uint8Array; contentType: string }>();
  for (const [key, value] of Object.entries(initial)) {
    map.set(key, { data: new TextEncoder().encode(value.data), contentType: value.contentType });
  }
  return {
    map,
    bucket: {
      async get(key: string) {
        const obj = map.get(key);
        if (!obj) return null;
        return {
          body: streamFromBytes(obj.data),
          size: obj.data.length,
          httpMetadata: { contentType: obj.contentType },
          writeHttpMetadata(headers: Headers) { headers.set("Content-Type", obj.contentType); },
        };
      },
      async put(key: string, body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, opts?: { httpMetadata?: { contentType?: string } }) {
        const data = await bytesFromBody(body);
        map.set(key, { data, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
        return { size: data.length };
      },
      async delete(key: string) { map.delete(key); },
    },
  };
}

function loadSchema(sqlite: DatabaseSync) {
  const schema = readFileSync(join(process.cwd(), "worker/migrations/Schema.sql"), "utf-8");
  sqlite.exec(schema);
}

function seedCommon(sqlite: DatabaseSync, username: string, password: string, level: number) {
  sqlite.prepare("INSERT INTO users (username, master_password, level, enabled) VALUES (?, 'hash', ?, 1)").run(username, level);
  sqlite.prepare("INSERT INTO subsonic_credentials (id, username, password, label, stream_proxy_strategy) VALUES (?, ?, ?, 'local-test', 'always')")
    .run(`cred-${username}`, username, password);
}

function seedUpstream(sqlite: DatabaseSync) {
  seedCommon(sqlite, "alice", "alicepw", 3);
  sqlite.exec(`
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-a', 'Local Artist', 'local artist');
    INSERT INTO albums (id, name, sort_name, song_count, duration, size) VALUES ('al-a', 'Local Album', 'local album', 1, 180, 16);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, duration, track, genre)
      VALUES ('sg-a', 'al-a', 'ar-a', 'Bridge Song', 'bridge song', 180, 1, 'test');
    INSERT INTO song_instances (id, master_id, source_id, source_type, storage_uri, suffix, content_type, bit_rate, duration, size, missing, tag_scanned)
      VALUES ('si-a', 'sg-a', 'r2-local', 'original', 'r2://music/upstream/bridge.flac', 'flac', 'audio/flac', 1411, 180, 16, 0, 1);
    INSERT INTO annotations (user_id, item_id, item_type, play_count, starred, starred_at)
      VALUES ('alice', 'sg-a', 'song', 0, 1, 1700000000);
    INSERT INTO playlists (id, name, owner, public, song_count, duration)
      VALUES ('pl-a', 'A Playlist', 'alice', 0, 1, 180);
    INSERT INTO playlist_songs (playlist_id, song_master_id, position)
      VALUES ('pl-a', 'sg-a', 0);
  `);
}

function seedDownstream(sqlite: DatabaseSync) {
  seedCommon(sqlite, "admin", "adminpw", 3);
  sqlite.exec(`
    INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at)
      VALUES ('sess-admin', 'admin', 'admin-session-token', 'two-local-services-test', unixepoch() + 3600, unixepoch());
    INSERT INTO artists (id, name, sort_name) VALUES ('ar-local', 'Local Artist', 'local artist');
    INSERT INTO albums (id, name, sort_name, song_count, duration, size) VALUES ('al-local', 'Local Album', 'local album', 1, 180, 0);
    INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, duration, track, genre)
      VALUES ('sg-local', 'al-local', 'ar-local', 'Bridge Song', 'bridge song', 180, 1, 'test');
  `);
}

function collectBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeNodeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

async function startService(name: string, env: any): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = new Hono();
  app.use("/rest/*", formPostMiddleware);
  app.use("/rest/*", formatMiddleware);
  app.use("/rest/*", authMiddleware);
  app.use("/tag/*", authMiddleware);
  app.use("/storage/*", authMiddleware);
  app.use("/edgesonic/*", authMiddleware);
  registerRoutes(app);
  app.onError((err, c) => {
    const isSubsonic = new URL(c.req.url).pathname.startsWith("/rest/");
    if (isSubsonic) {
      const xml = subsonicError(0, err.message);
      const format = (c.req.query("f") || "xml").toLowerCase();
      if (format === "json") return c.text(JSON.stringify(xmlToJson(xml)), 200, { "Content-Type": "application/json; charset=UTF-8" });
      return c.text(xml, 200, { "Content-Type": "application/xml; charset=UTF-8" });
    }
    return c.json({ ok: false, error: err.message }, 500);
  });

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      const url = `http://${host}${req.url || "/"}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value !== undefined) headers.set(key, String(value));
      }
      const body = await collectBody(req);
      const request = new Request(url, { method: req.method, headers, body });
      const ctx = { waitUntil() {}, passThroughOnException() {} };
      const response = await app.fetch(request, env, ctx as any);
      await writeNodeResponse(res, response);
    } catch (e) {
      res.statusCode = 500;
      res.end(`${name} failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function edgeAuthHeaders() {
  return { Cookie: "edgesonic_session=admin-session-token" };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { resp, json, text };
}

async function main() {
  const aDb = new DatabaseSync(":memory:");
  const bDb = new DatabaseSync(":memory:");
  loadSchema(aDb);
  loadSchema(bDb);
  seedUpstream(aDb);
  seedDownstream(bDb);

  const aR2 = makeR2({ "music/upstream/bridge.flac": { data: "UPSTREAM_AUDIO", contentType: "audio/flac" } });
  const bR2 = makeR2();
  const aEnv = { DB: makeD1(aDb), MUSIC_BUCKET: aR2.bucket, INSTANCE_ID: "local-a" };
  const bEnv = { DB: makeD1(bDb), MUSIC_BUCKET: bR2.bucket, INSTANCE_ID: "local-b" };

  const serviceA = await startService("service-a", aEnv);
  const serviceB = await startService("service-b", bEnv);
  console.log(`service A: ${serviceA.baseUrl}`);
  console.log(`service B: ${serviceB.baseUrl}`);

  try {
    console.log("A exposes Subsonic API over local HTTP:");
    const ping = await fetch(`${serviceA.baseUrl}/rest/ping?u=alice&p=alicepw&f=json`);
    const pingJson = await ping.json() as any;
    assert(ping.status === 200, `A /rest/ping HTTP 200 (got ${ping.status})`);
    assert(pingJson["subsonic-response"]?.status === "ok", "A /rest/ping status=ok");

    const ext = await fetch(`${serviceA.baseUrl}/rest/getOpenSubsonicExtensions?f=json`);
    const extJson = await ext.json() as any;
    const exts = extJson["subsonic-response"]?.openSubsonicExtensions || [];
    const cloneExt = exts.find((e: any) => e.name === "edgeSonicCloneProxy");
    assert(cloneExt?.proxy === "true", "A declares edgeSonicCloneProxy proxy=true");
    assert(cloneExt?.autoMerge === "true", "A declares edgeSonicCloneProxy autoMerge=true");
    assert(cloneExt?.fuzzyMerge === "true", "A declares edgeSonicCloneProxy fuzzyMerge=true");

    console.log("B clone/proxy can call A getStarred2:");
    const proxied = await postJson(`${serviceB.baseUrl}/edgesonic/clone/proxy`, {
      upstreamUrl: serviceA.baseUrl,
      username: "alice",
      password: "alicepw",
      path: "getStarred2",
      params: {},
      binary: false,
    }, edgeAuthHeaders());
    assert(proxied.resp.status === 200, `B proxy HTTP 200 (got ${proxied.resp.status})`);
    const proxiedSongs = proxied.json?.["subsonic-response"]?.starred2?.song;
    const proxiedArr = Array.isArray(proxiedSongs) ? proxiedSongs : (proxiedSongs ? [proxiedSongs] : []);
    assert(proxiedArr.some((s: any) => s.id === "sg-a"), "B proxy sees A starred song sg-a");

    console.log("B maps A remote song id to existing local song:");
    const mapped = await postJson(`${serviceB.baseUrl}/edgesonic/clone/upsertMaster`, {
      sourceKey: "local-http-a",
      artist: { id: "ar-a", name: "Local Artist" },
      album: { id: "al-a", name: "Local Album" },
      song: { id: "sg-a", albumId: "al-a", artistId: "ar-a", title: "Bridge Song", duration: 180 },
    }, edgeAuthHeaders());
    assert(mapped.resp.status === 200, `B upsertMaster HTTP 200 (got ${mapped.resp.status})`);
    assert(mapped.json.masterId === "sg-local", `B maps sg-a -> sg-local (got ${mapped.json.masterId})`);

    console.log("B pulls audio from A /rest/stream through fetchAudioToR2:");
    const pulled = await postJson(`${serviceB.baseUrl}/edgesonic/clone/fetchAudioToR2`, {
      upstreamUrl: serviceA.baseUrl,
      username: "alice",
      password: "alicepw",
      songId: "sg-a",
      masterId: "sg-a",
      sourceKey: "local-http-a",
      suffix: "flac",
      contentType: "audio/flac",
      artist: "Local Artist",
      album: "Local Album",
      filename: "Bridge Song.flac",
      originalPath: "/app/media/music/upstream/original bridge.FLAC",
      size: 14,
    }, edgeAuthHeaders());
    assert(pulled.resp.status === 200, `B fetchAudioToR2 HTTP 200 (got ${pulled.resp.status}) body=${pulled.text}`);
    assert(pulled.json.ok === true, "B fetchAudioToR2 ok=true");
    assert(pulled.json.r2Key === "music/upstream/original bridge.FLAC", `B preserves upstream path in R2 key (got ${pulled.json.r2Key})`);
    const inst = bDb.prepare("SELECT master_id, storage_uri FROM song_instances WHERE storage_uri = 'r2://music/upstream/original bridge.FLAC'").get() as any;
    assert(inst?.master_id === "sg-local", `B registered pulled audio under sg-local (got ${inst?.master_id})`);
    const stored = bR2.map.get("music/upstream/original bridge.FLAC");
    assert(new TextDecoder().decode(stored?.data || new Uint8Array()) === "UPSTREAM_AUDIO", "B R2 contains bytes fetched from A");

    console.log("B applies A starred and playlist references through the same mapping:");
    const starred = await postJson(`${serviceB.baseUrl}/edgesonic/clone/upsertStarred`, {
      sourceKey: "local-http-a",
      userId: "admin",
      items: [{ id: "sg-a", type: "song" }],
    }, edgeAuthHeaders());
    assert(starred.resp.status === 200 && starred.json.ok === true, "B upsertStarred ok");
    const ann = bDb.prepare("SELECT starred FROM annotations WHERE user_id='admin' AND item_id='sg-local' AND item_type='song'").get() as any;
    assert(ann?.starred === 1, "B starred row uses local sg-local");

    const playlist = await postJson(`${serviceB.baseUrl}/edgesonic/clone/upsertPlaylist`, {
      sourceKey: "local-http-a",
      playlist: { id: "pl-a", name: "A Playlist", owner: "alice", public: false },
      entries: ["sg-a"],
    }, edgeAuthHeaders());
    assert(playlist.resp.status === 200 && playlist.json.ok === true, "B upsertPlaylist ok");
    const pl = bDb.prepare("SELECT owner, song_count FROM playlists WHERE id='pl-a'").get() as any;
    assert(pl?.owner === "admin", `B playlist owner falls back to admin (got ${pl?.owner})`);
    assert(pl?.song_count === 1, `B playlist song_count=1 (got ${pl?.song_count})`);
    const entry = bDb.prepare("SELECT song_master_id FROM playlist_songs WHERE playlist_id='pl-a'").get() as any;
    assert(entry?.song_master_id === "sg-local", `B playlist entry uses sg-local (got ${entry?.song_master_id})`);
  } finally {
    await serviceB.close();
    await serviceA.close();
    console.log("local services stopped");
  }

  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
