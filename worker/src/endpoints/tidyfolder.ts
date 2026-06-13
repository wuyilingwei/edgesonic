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

// 042 — POST /rest/tidyFolder
// Move song files into a consistent folder layout driven by a template like
// `{albumArtist}/{album}/{track:02d} - {title}`. Only R2 and WebDAV
// instances are movable; other sources (subsonic, url) are skipped with a
// reason. dryRun:true returns the plan without touching storage.
//
// Body:
//   { template: string, ids: string[], source?: "r2"|"webdav", dryRun?: boolean }
// Response:
//   {
//     ok: true,
//     planned: [{ id, instanceId, from, to, skipped? }],
//     applied: [{ id, instanceId, ok, error? }],
//     failed: number
//   }
//
// Permission: manage_files (session-only). See migration 0013.

import { Hono } from "hono";
import { permissionMiddleware } from "../auth";
import { createQueries } from "../db/queries";
import { encodePath } from "./scan";

export const tidyFolderRoutes = new Hono();

const ID_BATCH_MAX = 100; // Workers single-request CPU + bucket-op budget

interface PlannedMove {
  id: string;
  instanceId: string;
  from: string;
  to: string;
  skipped?: string;       // populated when the instance can't be moved (e.g. read-only source)
}

interface AppliedMove {
  id: string;
  instanceId: string;
  ok: boolean;
  error?: string;
}

interface SourceRow {
  id: string;
  type: string;
  base_url: string;
  username: string | null;
  password: string | null;
  root_path: string | null;
}

tidyFolderRoutes.post("/rest/tidyFolder", permissionMiddleware("manage_files"), async (c) => {
  const env = c.env as Env;
  const db = env.DB;
  const queries = createQueries(db);

  const body = await c.req.json<{
    template?: string;
    ids?: string[];
    source?: "r2" | "webdav";
    dryRun?: boolean;
  }>().catch(() => null);

  if (!body?.template || !Array.isArray(body.ids)) {
    return c.json({ ok: false, error: "Missing template or ids" }, 400);
  }
  if (body.ids.length === 0) return c.json({ ok: false, error: "Empty ids" }, 400);
  if (body.ids.length > ID_BATCH_MAX) {
    return c.json({ ok: false, error: `Too many ids (max ${ID_BATCH_MAX})` }, 400);
  }
  if (!body.template.trim()) return c.json({ ok: false, error: "Empty template" }, 400);

  const sources = await loadSources(db);
  const planned: PlannedMove[] = [];
  const applied: AppliedMove[] = [];
  let failed = 0;

  for (const id of body.ids) {
    let master = await queries.getSongMaster(id);
    if (!master) {
      const inst = await queries.getSongInstance(id);
      if (inst) master = await queries.getSongMaster(inst.master_id);
    }
    if (!master) {
      failed++;
      applied.push({ id, instanceId: "", ok: false, error: "Song not found" });
      continue;
    }
    const artistRow = await db.prepare("SELECT name FROM artists WHERE id = ?")
      .bind(master.artist_id).first<{ name: string }>();
    const albumRow = await db.prepare("SELECT name, year, genre FROM albums WHERE id = ?")
      .bind(master.album_id).first<{ name: string; year: number | null; genre: string | null }>();
    const albumArtistRow = master.album_artist_id
      ? await db.prepare("SELECT name FROM artists WHERE id = ?").bind(master.album_artist_id).first<{ name: string }>()
      : null;

    const ctx = {
      title: master.title || "Unknown Title",
      artist: artistRow?.name || "Unknown Artist",
      albumArtist: albumArtistRow?.name || artistRow?.name || "Unknown Artist",
      album: albumRow?.name || "Unknown Album",
      year: albumRow?.year ? String(albumRow.year) : "",
      track: master.track ?? null,
    };

    const instances = await queries.getSongInstances(master.id);
    for (const inst of instances) {
      const scheme = inst.storage_uri.split("://")[0];
      const wantSource = body.source;
      if (wantSource === "r2" && scheme !== "r2") continue;
      if (wantSource === "webdav" && scheme !== "webdav") continue;
      if (scheme !== "r2" && scheme !== "webdav") {
        planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: "", skipped: `source ${scheme} is read-only` });
        continue;
      }
      const suffix = (inst.suffix || "").toLowerCase() || "bin";
      const targetRel = renderTemplate(body.template, ctx);
      if (!targetRel) {
        planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: "", skipped: "template rendered empty" });
        continue;
      }

      let toUri: string;
      if (scheme === "r2") {
        const fromKey = inst.storage_uri.substring("r2://".length);
        const rootPrefix = inferR2Root(fromKey);             // keep the existing top-level music/ prefix
        const toKey = `${rootPrefix}${targetRel}.${suffix}`;
        toUri = `r2://${toKey}`;
        if (toUri === inst.storage_uri) {
          planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: toUri, skipped: "already at target" });
          continue;
        }
        planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: toUri });
      } else {
        // webdav://<source_id>/<path>
        const after = inst.storage_uri.substring("webdav://".length);
        const slash = after.indexOf("/");
        const sourceId = slash < 0 ? after : after.substring(0, slash);
        const oldPath = slash < 0 ? "" : after.substring(slash + 1);
        const rootPrefix = inferWebdavRoot(oldPath);
        const toPath = `${rootPrefix}${targetRel}.${suffix}`;
        toUri = `webdav://${sourceId}/${toPath}`;
        if (toUri === inst.storage_uri) {
          planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: toUri, skipped: "already at target" });
          continue;
        }
        planned.push({ id, instanceId: inst.id, from: inst.storage_uri, to: toUri });
      }

      if (body.dryRun) continue;

      try {
        await applyMove(env, db, sources, inst.storage_uri, toUri);
        applied.push({ id, instanceId: inst.id, ok: true });
      } catch (e) {
        failed++;
        applied.push({ id, instanceId: inst.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return c.json({ ok: true, planned, applied, failed, dryRun: !!body.dryRun });
});

async function loadSources(db: D1Database): Promise<Map<string, SourceRow>> {
  const sources = new Map<string, SourceRow>();
  const rows = await db.prepare(
    "SELECT id, type, base_url, username, password, root_path FROM storage_sources WHERE enabled = 1"
  ).all<SourceRow>();
  for (const s of rows.results) sources.set(s.id, s);
  return sources;
}

// Keep tracks anchored under whatever top-level folder they came from. For R2
// that is virtually always `music/`; for WebDAV the user may have a different
// root_path. This stops `tidyFolder` from inadvertently moving files outside
// of the music root.
function inferR2Root(key: string): string {
  const i = key.indexOf("/");
  if (i < 0) return "music/";
  return key.substring(0, i + 1);
}
function inferWebdavRoot(path: string): string {
  const i = path.indexOf("/");
  if (i < 0) return "";
  return path.substring(0, i + 1);
}

// Template renderer — supports {artist}, {albumArtist}, {album}, {title},
// {year}, {track}, and {track:02d} (zero-pad). Unknown placeholders are kept
// as-is so a typo doesn't silently destroy the path.
const PLACEHOLDER_RE = /\{(artist|albumArtist|album|title|year|track)(:\d+d)?\}/g;
export function renderTemplate(
  template: string,
  ctx: { title: string; artist: string; albumArtist: string; album: string; year: string; track: number | null },
): string {
  const rendered = template.replace(PLACEHOLDER_RE, (_full, key: string, fmt?: string) => {
    let value = "";
    if (key === "track") {
      if (ctx.track == null) return "";
      if (fmt) {
        const width = parseInt(fmt.slice(1, -1), 10);
        value = String(ctx.track).padStart(width, "0");
      } else value = String(ctx.track);
    } else {
      value = String((ctx as unknown as Record<string, string>)[key] || "");
    }
    return sanitiseSegment(value);
  });
  // Tidy double slashes that come from empty placeholders, then collapse leading/trailing slashes.
  return rendered.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

// Replace characters that are illegal in R2 keys / common filesystems with an
// underscore. Keeps unicode (artist names like 周杰倫 stay intact).
function sanitiseSegment(s: string): string {
  return s.replace(/[\/<>:"\\|?*\x00-\x1f]/g, "_").replace(/\s+$/g, "").replace(/^\./, "_");
}

// Per-instance move: R2 → bucket copy + delete; WebDAV → HTTP MOVE (with a
// GET/PUT/DELETE fallback for servers that reject MOVE). Storage URI in D1 is
// updated atomically with the storage side-effect.
async function applyMove(env: Env, db: D1Database, sources: Map<string, SourceRow>, fromUri: string, toUri: string) {
  if (fromUri.startsWith("r2://") && toUri.startsWith("r2://")) {
    const fromKey = fromUri.substring("r2://".length);
    const toKey = toUri.substring("r2://".length);
    const obj = await env.MUSIC_BUCKET.get(fromKey);
    if (!obj) throw new Error("source object not found");
    await env.MUSIC_BUCKET.put(toKey, obj.body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
    await env.MUSIC_BUCKET.delete(fromKey);
  } else if (fromUri.startsWith("webdav://") && toUri.startsWith("webdav://")) {
    const fromAfter = fromUri.substring("webdav://".length);
    const fromSlash = fromAfter.indexOf("/");
    if (fromSlash < 0) throw new Error("malformed webdav from-URI");
    const sourceId = fromAfter.substring(0, fromSlash);
    const fromPath = fromAfter.substring(fromSlash + 1);

    const toAfter = toUri.substring("webdav://".length);
    const toSlash = toAfter.indexOf("/");
    if (toSlash < 0) throw new Error("malformed webdav to-URI");
    const toPath = toAfter.substring(toSlash + 1);

    const src = sources.get(sourceId);
    if (!src) throw new Error("source not found or disabled");
    const root = (src.root_path || "").replace(/^\/+|\/+$/g, "");
    const buildUrl = (p: string) =>
      src.base_url.replace(/\/+$/, "") + (root ? `/${root}` : "") + "/" + encodePath(p);
    const auth = `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`;

    // First attempt: WebDAV MOVE — single round-trip on compliant servers.
    const moveResp = await fetch(buildUrl(fromPath), {
      method: "MOVE",
      headers: { Authorization: auth, Destination: buildUrl(toPath), Overwrite: "F" },
    });
    if (!(moveResp.status >= 200 && moveResp.status < 300)) {
      // Fallback for servers that reject MOVE (e.g. some R2-fronted bridges):
      // GET → PUT → DELETE. Heavier but works on plain HTTP-2 backends.
      const getResp = await fetch(buildUrl(fromPath), { headers: { Authorization: auth } });
      if (!getResp.ok) throw new Error(`GET failed: HTTP ${getResp.status}`);
      const buf = await getResp.arrayBuffer();
      const putResp = await fetch(buildUrl(toPath), {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": getResp.headers.get("Content-Type") || "application/octet-stream" },
        body: buf,
      });
      if (!putResp.ok) throw new Error(`PUT failed: HTTP ${putResp.status}`);
      const delResp = await fetch(buildUrl(fromPath), { method: "DELETE", headers: { Authorization: auth } });
      if (!delResp.ok && delResp.status !== 404) throw new Error(`DELETE failed: HTTP ${delResp.status}`);
    }
  } else {
    throw new Error(`cross-scheme move not supported (${fromUri} → ${toUri})`);
  }

  await db.prepare("UPDATE song_instances SET storage_uri = ?, updated_at = ? WHERE storage_uri = ?")
    .bind(toUri, Math.floor(Date.now() / 1000), fromUri).run();
}
