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

<script setup lang="ts">
// 104 — Tools page. The 094 Subsonic clone (pull) and the 104 push-to-upstream
// used to live inside Settings; they are workflows rather than configuration,
// so they get their own page with one sub-page per direction. The credential
// form is shared — both directions talk to the same upstream server.
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const { t } = useI18n();
const { isSuperAdmin, edgesonicPost, md5, signedParams, restUrl } = useAuth();

// === Toast (same shape as Settings.vue's) ===
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// === Sub-page tabs ===
type ToolTab = "clone" | "push";
const tab = ref<ToolTab>("clone");

// === 094 — Subsonic server clone ===
// Browser-driven clone: the SPA fetches metadata + bytes directly from the
// upstream Subsonic server (using Subsonic MD5 token auth: t = md5(password
// + salt), s = salt) and POSTs each item to /edgesonic/clone/* to persist
// locally. Keeping the loop client-side avoids Worker CPU-time timeouts
// when the upstream library is large.
//
// Stages run sequentially:
//   1. metadata  — getAlbumList2 → getAlbum → upsertMaster per song
//   2. audio     — (optional) stream → ingestAudio per song
//   3. playlists — getPlaylists → getPlaylist → upsertPlaylist
//   4. starred   — getStarred2 → upsertStarred
//   5. users     — (admin upstream only) getUsers → upsertUser
//
// Each stage exposes a reactive progress object so the UI can render
// "X / Y" counters and a per-stage status pill.
interface CloneForm { url: string; username: string; password: string; }
const cloneForm = ref<CloneForm>({ url: "", username: "", password: "" });
const cloneAudioEnabled = ref(false);
const cloneUsersEnabled = ref(false);
const cloneRunning = ref(false);
const cloneCancelRequested = ref(false);

interface CloneProgress {
  total: number;
  done: number;
  failed: number;
  status: "idle" | "running" | "done" | "error" | "skipped";
  message: string;
}
function newCloneProgress(): CloneProgress {
  return { total: 0, done: 0, failed: 0, status: "idle", message: "" };
}
const cloneStages = ref({
  metadata: newCloneProgress(),
  audio: newCloneProgress(),
  playlists: newCloneProgress(),
  starred: newCloneProgress(),
  users: newCloneProgress(),
});
const cloneLog = ref<string[]>([]);
function cloneLogPush(line: string) {
  cloneLog.value.push(line);
  if (cloneLog.value.length > 500) cloneLog.value.splice(0, cloneLog.value.length - 500);
}

// Build the upstream Subsonic auth query string for a single call.
// t = md5(password + salt), s = salt — the same scheme EdgeSonic uses
// in api.ts:signedParams, but signed with the *upstream* password.
function cloneSignedParams(extra?: Record<string, string>): URLSearchParams {
  const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
  return new URLSearchParams({
    u: cloneForm.value.username,
    t: md5(cloneForm.value.password + s),
    s,
    v: "1.16.1",
    c: "EdgeSonicClone",
    f: "json",
    ...extra,
  });
}

function cloneUpstreamUrl(path: string, params?: Record<string, string>): string {
  const base = cloneForm.value.url.replace(/\/+$/, "");
  return `${base}/rest/${path}?${cloneSignedParams(params).toString()}`;
}

// Subsonic JSON responses come back as { "subsonic-response": { ... } }.
// We tolerate either JSON or XML for getAlbumList2/getAlbum/getSong etc;
// when the server only speaks XML (older Navidrome / supysonic), we parse
// the attributes out of the XML.
async function cloneFetchJson(path: string, params?: Record<string, string>): Promise<any> {
  const resp = await fetch(cloneUpstreamUrl(path, params));
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    return json?.["subsonic-response"] ?? json;
  } catch {
    return { _xml: text };
  }
}

// Generic attribute parser for XML-fallback responses.
function parseXmlChildren(xml: string, tag: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*/?>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    items.push(attrs);
  }
  return items;
}

// Pull a value from a Subsonic JSON node OR fall back to the XML parse.
function jget(node: any, key: string): string | undefined {
  if (node && typeof node === "object") {
    const v = node[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
    // Some Subsonic servers wrap scalars in { _value: ... } — handle both.
    if (v && typeof v === "object" && "_value" in v) return String((v as any)._value);
  }
  return undefined;
}

// Normalize a Subsonic song node (from getAlbum.songs / getStarred2.song /
// getPlaylist.entries) into the shape upsertMaster expects.
function normalizeSongNode(song: any, album: any, artist: any): {
  artist: { id: string; name: string; sortName?: string | null };
  album: { id: string; name: string; sortName?: string | null; year?: number | null; genre?: string | null };
  song: {
    id: string; albumId: string; artistId: string; albumArtistId?: string | null;
    title: string; sortTitle?: string | null;
    track?: number | null; disc?: number | null;
    duration?: number | null; genre?: string | null;
    compilation?: number | null;
  };
  albumArtist?: { id: string; name: string; sortName?: string | null };
} {
  const artistName = jget(song, "artist") || jget(album, "artist") || jget(artist, "name") || "Unknown Artist";
  const albumArtistName = jget(song, "albumArtist") || jget(album, "artist") || artistName;
  const artistId = jget(song, "artistId") || jget(artist, "id") || "ar-" + simpleHash(artistName);
  const albumId = jget(song, "albumId") || jget(album, "id") || "al-" + simpleHash(albumArtistName + " " + (jget(album, "name") || "Unknown Album"));
  const albumArtistId = (jget(song, "albumArtistId") || "ar-" + simpleHash(albumArtistName)) ?? null;

  return {
    artist: {
      id: artistId,
      name: artistName,
      sortName: artistName.toLowerCase(),
    },
    album: {
      id: albumId,
      name: jget(album, "name") || jget(song, "album") || "Unknown Album",
      sortName: (jget(album, "name") || jget(song, "album") || "Unknown Album").toLowerCase(),
      year: numOr(jget(album, "year") || jget(song, "year"), null),
      genre: jget(album, "genre") || jget(song, "genre") || null,
    },
    song: {
      id: jget(song, "id") || "sm-clone-" + simpleHash(artistName + (jget(song, "title") || "") + albumId),
      albumId,
      artistId,
      albumArtistId: albumArtistId === artistId ? null : albumArtistId,
      title: jget(song, "title") || "Unknown Title",
      sortTitle: (jget(song, "title") || "Unknown Title").toLowerCase(),
      track: numOr(jget(song, "track"), null),
      disc: numOr(jget(song, "discNumber"), null),
      duration: numOr(jget(song, "duration"), null),
      genre: jget(song, "genre") || null,
      compilation: jget(album, "isCompilation") === "true" ? 1 : 0,
    },
    albumArtist: albumArtistId && albumArtistId !== artistId
      ? { id: albumArtistId, name: albumArtistName, sortName: albumArtistName.toLowerCase() }
      : undefined,
  };
}

function numOr(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Tiny non-crypto hash for synthesising Subsonic-style ids when the upstream
// server omits them. Subsonic ids are opaque strings so a stable 10-char
// hash matches the EdgeSonic convention (ar-/al-/sm- prefixes use md5[:10]).
function simpleHash(input: string): string {
  // Reuse the project's md5 from api.ts for stable ids.
  return md5(input).substring(0, 10);
}

// Sanitise a path component for R2 keys — replaces path separators and trims.
function sanitizePathPart(s: string, fallback: string): string {
  const cleaned = (s || "").replace(/[\/\\]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

// Format bytes for the log.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Stage 1 — metadata. Walk getAlbumList2 (alphabeticalByName, large size),
// then getAlbum per album, then POST /clone/upsertMaster per song.
async function cloneMetadataStage() {
  const stage = cloneStages.value.metadata;
  stage.status = "running";
  stage.message = "";
  const PAGE = 500;
  let offset = 0;
  const albumIds: { id: string; name: string; artist: string }[] = [];
  // Page through album list until we get fewer than requested.
  while (!cloneCancelRequested.value) {
    const resp = await cloneFetchJson("getAlbumList2", { type: "alphabeticalByName", size: String(PAGE), offset: String(offset) });
    if (resp?._xml) {
      const items = parseXmlChildren(resp._xml, "album");
      for (const a of items) {
        albumIds.push({ id: a.id || "", name: a.name || "Unknown Album", artist: a.artist || a.artistId || "" });
      }
      if (items.length < PAGE) break;
    } else {
      const albums = resp?.albumList2?.album || resp?.albums?.album || [];
      const arr = Array.isArray(albums) ? albums : (albums ? [albums] : []);
      if (arr.length === 0) break;
      for (const a of arr) {
        albumIds.push({ id: jget(a, "id") || "", name: jget(a, "name") || "Unknown Album", artist: jget(a, "artist") || "" });
      }
      if (arr.length < PAGE) break;
    }
    offset += PAGE;
  }
  stage.total = albumIds.length;
  cloneLogPush(`metadata: ${albumIds.length} album(s) discovered`);

  for (const meta of albumIds) {
    if (cloneCancelRequested.value) break;
    try {
      const albumResp = await cloneFetchJson("getAlbum", { id: meta.id });
      let albumNode: any = meta;
      let songs: any[] = [];
      if (albumResp?._xml) {
        // XML fallback — parse <album .../> and <song .../> siblings.
        const albumMatch = /<album\s+([^>]+?)\s*\/?>/.exec(albumResp._xml);
        if (albumMatch) {
          const attrs: Record<string, string> = {};
          const attrRe = /(\w+)="([^"]*)"/g;
          let am;
          while ((am = attrRe.exec(albumMatch[1]))) attrs[am[1]] = am[2];
          albumNode = attrs;
        }
        songs = parseXmlChildren(albumResp._xml, "song");
      } else {
        albumNode = albumResp?.album || albumNode;
        const raw = albumResp?.album?.song || albumResp?.songs?.song || [];
        songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      }
      for (const s of songs) {
        if (cloneCancelRequested.value) break;
        const payload = normalizeSongNode(s, albumNode, { id: "", name: meta.artist });
        try {
          const data = JSON.parse(await edgesonicPost("clone/upsertMaster", payload));
          if (!data.ok) throw new Error(data.error || "upsertMaster rejected");
          stage.done++;
        } catch (e: unknown) {
          stage.failed++;
          cloneLogPush(`metadata: ✗ ${payload.song.title} — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`metadata: ✗ album ${meta.name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
  stage.message = cloneCancelRequested.value ? "cancelled" : "";
}

// Stage 2 — audio. For every song_master already cloned, fetch the upstream
// /rest/stream bytes and POST them to /clone/ingestAudio.
async function cloneAudioStage() {
  const stage = cloneStages.value.audio;
  if (!cloneAudioEnabled.value) {
    stage.status = "skipped";
    stage.message = "disabled";
    return;
  }
  stage.status = "running";
  // We re-walk getAlbumList2 / getAlbum to get song ids + paths so the
  // browser doesn't need a separate "list of cloned masters" round-trip.
  // The upsertMaster stage already inserted the rows, so ingestAudio's
  // masterId lookup will succeed.
  const PAGE = 500;
  let offset = 0;
  const allSongs: { id: string; title: string; album: string; albumId: string; artist: string; suffix: string; contentType: string; size: number }[] = [];
  while (!cloneCancelRequested.value) {
    const resp = await cloneFetchJson("getAlbumList2", { type: "alphabeticalByName", size: String(PAGE), offset: String(offset) });
    let albums: any[] = [];
    if (resp?._xml) {
      albums = parseXmlChildren(resp._xml, "album");
    } else {
      const raw = resp?.albumList2?.album || resp?.albums?.album || [];
      albums = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    if (albums.length === 0) break;
    for (const a of albums) {
      const albumId = jget(a, "id") || "";
      const albumName = jget(a, "name") || "Unknown Album";
      const albumArtist = jget(a, "artist") || "Unknown Artist";
      const detail = await cloneFetchJson("getAlbum", { id: albumId });
      let songs: any[] = [];
      if (detail?._xml) {
        songs = parseXmlChildren(detail._xml, "song");
      } else {
        const raw = detail?.album?.song || detail?.songs?.song || [];
        songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      }
      for (const s of songs) {
        allSongs.push({
          id: jget(s, "id") || "",
          title: jget(s, "title") || "Unknown Title",
          album: albumName,
          albumId,
          artist: jget(s, "artist") || albumArtist,
          suffix: (jget(s, "suffix") || jget(s, "format") || "mp3").toLowerCase(),
          contentType: jget(s, "contentType") || suffixToMime((jget(s, "suffix") || "mp3").toLowerCase()),
          size: numOr(jget(s, "size"), 0) || 0,
        });
      }
    }
    if (albums.length < PAGE) break;
    offset += PAGE;
  }
  stage.total = allSongs.length;
  cloneLogPush(`audio: ${allSongs.length} song(s) to fetch`);

  for (const s of allSongs) {
    if (cloneCancelRequested.value) break;
    try {
      const streamUrl = cloneUpstreamUrl("stream", { id: s.id });
      const resp = await fetch(streamUrl);
      if (!resp.ok) throw new Error(`stream ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("empty body");
      const filename = `${sanitizePathPart(s.title, "track")}.${s.suffix}`;
      const artistDir = sanitizePathPart(s.artist, "Unknown Artist");
      const albumDir = sanitizePathPart(s.album, "Unknown Album");
      // Derive the masterId consistently with normalizeSongNode so the
      // backend's FK lookup matches the row inserted in stage 1. We use
      // the upstream album id directly when present — upsertMaster stored
      // under that same albumId.
      const realAlbumId = s.albumId || ("al-" + simpleHash(s.artist + " " + s.album));
      const realMasterId = s.id || ("sm-clone-" + simpleHash(s.artist + s.title + realAlbumId));
      const qs = new URLSearchParams({
        masterId: realMasterId,
        suffix: s.suffix,
        contentType: s.contentType,
        artist: artistDir,
        album: albumDir,
        filename,
        size: String(s.size || buf.byteLength),
      });
      // Reuse the session-signed edgesonicPost path but with a binary body.
      // edgesonicPost builds JSON; we need a raw PUT here, so sign manually.
      const sp = signedParamsCloneEdge();
      const uploadResp = await fetch(`${EDGESONIC_CLONE_BASE}/clone/ingestAudio?${sp.toString()}&${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": s.contentType },
        body: buf,
      });
      const data = await uploadResp.json().catch(() => ({ ok: false, error: "non-json" }));
      if (!data.ok) throw new Error(data.error || "ingestAudio rejected");
      stage.done++;
      cloneLogPush(`audio: ✓ ${s.artist} — ${s.title} (${fmtBytes(buf.byteLength)})`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`audio: ✗ ${s.artist} — ${s.title} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// The clone endpoints live under /edgesonic/*, so they need the same
// session-signed query string as edgesonicPost. We can't call the closure
// inside useAuth from here, but useAuth() already returns signedParams().
// To keep this self-contained, sign against the same auth singleton.
function signedParamsCloneEdge(): URLSearchParams {
  // useAuth() exposes signedParams; we just re-import it here.
  return signedParams();
}

const EDGESONIC_CLONE_BASE = "/edgesonic";

function suffixToMime(suffix: string): string {
  switch (suffix.toLowerCase()) {
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "aac":  return "audio/aac";
    case "opus": return "audio/opus";
    case "ogg":  return "audio/ogg";
    case "flac": return "audio/flac";
    case "wav":  return "audio/wav";
    default:     return "application/octet-stream";
  }
}

// Stage 3 — playlists.
async function clonePlaylistsStage() {
  const stage = cloneStages.value.playlists;
  stage.status = "running";
  const resp = await cloneFetchJson("getPlaylists");
  let playlists: any[] = [];
  if (resp?._xml) {
    playlists = parseXmlChildren(resp._xml, "playlist");
  } else {
    const raw = resp?.playlists?.playlist || [];
    playlists = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  stage.total = playlists.length;
  cloneLogPush(`playlists: ${playlists.length} playlist(s)`);

  for (const p of playlists) {
    if (cloneCancelRequested.value) break;
    try {
      const id = jget(p, "id") || "";
      const name = jget(p, "name") || "Untitled";
      const owner = jget(p, "owner") || cloneForm.value.username;
      const isPublic = jget(p, "public") === "true";
      const comment = jget(p, "comment") || null;
      // Fetch the full playlist to get entry ids.
      const detail = await cloneFetchJson("getPlaylist", { id });
      let entries: string[] = [];
      if (detail?._xml) {
        const songs = parseXmlChildren(detail._xml, "entry");
        entries = songs.map((s) => s.id).filter(Boolean);
      } else {
        const raw = detail?.playlist?.entry || detail?.entries?.entry || [];
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        entries = arr.map((s) => jget(s, "id") || "").filter(Boolean);
      }
      const data = JSON.parse(await edgesonicPost("clone/upsertPlaylist", {
        playlist: { id, name, owner, public: isPublic, comment },
        entries,
      }));
      if (!data.ok) throw new Error(data.error || "upsertPlaylist rejected");
      stage.done++;
      cloneLogPush(`playlists: ✓ ${name} (${entries.length} entries)`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`playlists: ✗ ${jget(p, "name") || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// Stage 4 — starred.
async function cloneStarredStage() {
  const stage = cloneStages.value.starred;
  stage.status = "running";
  const resp = await cloneFetchJson("getStarred2");
  const items: Array<{ id: string; type: "song" | "album" | "artist"; starredAt?: number | null }> = [];
  if (resp?._xml) {
    for (const s of parseXmlChildren(resp._xml, "song")) items.push({ id: s.id, type: "song" });
    for (const a of parseXmlChildren(resp._xml, "album")) items.push({ id: a.id, type: "album" });
    for (const ar of parseXmlChildren(resp._xml, "artist")) items.push({ id: ar.id, type: "artist" });
  } else {
    const sr = resp?.starred2 || resp?.starred || {};
    for (const bucket of ["song", "album", "artist"] as const) {
      const raw = sr[bucket] || [];
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      for (const n of arr) {
        const id = jget(n, "id");
        if (id) items.push({ id, type: bucket });
      }
    }
  }
  stage.total = items.length;
  cloneLogPush(`starred: ${items.length} item(s)`);

  if (items.length > 0) {
    try {
      const data = JSON.parse(await edgesonicPost("clone/upsertStarred", {
        userId: cloneForm.value.username,
        items,
      }));
      if (!data.ok) throw new Error(data.error || "upsertStarred rejected");
      stage.done = items.length;
      cloneLogPush(`starred: ✓ ${items.length} applied`);
    } catch (e: unknown) {
      stage.failed = items.length;
      stage.status = "error";
      stage.message = e instanceof Error ? e.message : String(e);
      cloneLogPush(`starred: ✗ ${stage.message}`);
      return;
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// Stage 5 — users (requires upstream admin).
async function cloneUsersStage() {
  const stage = cloneStages.value.users;
  if (!cloneUsersEnabled.value) {
    stage.status = "skipped";
    stage.message = "disabled";
    return;
  }
  stage.status = "running";
  const resp = await cloneFetchJson("getUsers");
  let users: any[] = [];
  if (resp?._xml) {
    users = parseXmlChildren(resp._xml, "user");
  } else {
    const raw = resp?.users?.user || [];
    users = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  stage.total = users.length;
  cloneLogPush(`users: ${users.length} user(s)`);

  for (const u of users) {
    if (cloneCancelRequested.value) break;
    try {
      const username = jget(u, "username") || "";
      const password = jget(u, "password") || "";
      const level = (jget(u, "adminRole") === "true" || jget(u, "isAdmin") === "true") ? 3 : 1;
      const enabled = jget(u, "disabled") !== "true";
      if (!username || !password) {
        stage.failed++;
        cloneLogPush(`users: ✗ ${username || "?"} — missing username/password (upstream must expose password)`);
        continue;
      }
      const data = JSON.parse(await edgesonicPost("clone/upsertUser", {
        user: { username, password, level, enabled },
        credentials: [{ password, label: "cloned" }],
      }));
      if (!data.ok) throw new Error(data.error || "upsertUser rejected");
      stage.done++;
      cloneLogPush(`users: ✓ ${username}`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`users: ✗ ${jget(u, "username") || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

async function runClone() {
  if (!isSuperAdmin.value || cloneRunning.value) return;
  if (!cloneForm.value.url || !cloneForm.value.username || !cloneForm.value.password) {
    showToast(t("settings.common.clone.missingFields"), "error");
    return;
  }
  cloneRunning.value = true;
  cloneCancelRequested.value = false;
  cloneLog.value = [];
  for (const k of Object.keys(cloneStages.value) as Array<keyof typeof cloneStages.value>) {
    cloneStages.value[k] = newCloneProgress();
  }
  try {
    await cloneMetadataStage();
    await cloneAudioStage();
    await clonePlaylistsStage();
    await cloneStarredStage();
    await cloneUsersStage();
    showToast(t("settings.common.clone.done"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.clone.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  cloneRunning.value = false;
}

function cancelClone() {
  cloneCancelRequested.value = true;
}

// === 104 — Push local starred/playlists back TO the upstream ===
// The reverse direction of the 094 clone, same browser-driven shape and same
// upstream credential form. Local song ids mean nothing upstream, so each
// song is matched via upstream search3 using a *cleaned* title (leading track
// numbers like "01." / "01 - " / "#1 " stripped), and only written when the
// combined title/artist/duration confidence clears a threshold — a wrong
// star/playlist entry on the upstream is worse than a skipped one.
const pushRunning = ref(false);
const pushCancelRequested = ref(false);
const pushStages = ref({
  starred: newCloneProgress(),
  playlists: newCloneProgress(),
});
// title|artist → matched upstream id (or null after a failed search), so the
// starred pass and every playlist share one search per distinct song.
const pushMatchCache = new Map<string, string | null>();

// Strip decorations that differ between libraries but not between versions of
// the same song: leading track numbers ("01.", "01 - ", "#1 "), collapsed
// whitespace, case. Applied symmetrically to both sides before comparing.
function normalizeForMatch(raw: string | undefined): string {
  let s = (raw || "").toLowerCase();
  s = s.replace(/[#＃]\s*\d+\s*/g, " ");
  s = s.replace(/^\s*\d{1,3}\s*[-–—_.、．:：)）]\s*/, "");
  s = s.replace(/^\s*\d{1,3}\s+/, "");
  return s.replace(/\s+/g, " ").trim();
}

function scorePushCandidate(
  local: { titleN: string; artistN: string; duration: number | null },
  cand: any,
): number {
  const ct = normalizeForMatch(jget(cand, "title"));
  const ca = normalizeForMatch(jget(cand, "artist"));
  const cd = parseInt(jget(cand, "duration") || "", 10);
  if (!ct || !local.titleN) return 0;
  let score = 0;
  if (ct === local.titleN) score += 0.6;
  else if (ct.includes(local.titleN) || local.titleN.includes(ct)) score += 0.35;
  else return 0; // title is mandatory — artist/duration alone never qualify
  if (local.artistN && ca) {
    if (ca === local.artistN) score += 0.25;
    else if (ca.includes(local.artistN) || local.artistN.includes(ca)) score += 0.12;
  }
  if (local.duration !== null && Number.isFinite(cd) && Math.abs(cd - local.duration) <= 3) score += 0.15;
  return score;
}

const PUSH_MATCH_THRESHOLD = 0.75;

async function matchUpstreamSong(
  title: string | undefined,
  artist: string | undefined,
  duration: number | null,
): Promise<{ id: string; score: number } | null> {
  const titleN = normalizeForMatch(title);
  if (!titleN) return null;
  const artistN = normalizeForMatch(artist);
  const cacheKey = `${titleN}|${artistN}`;
  if (pushMatchCache.has(cacheKey)) {
    const cached = pushMatchCache.get(cacheKey);
    return cached ? { id: cached, score: 1 } : null;
  }
  const resp = await cloneFetchJson("search3", {
    query: titleN, songCount: "10", albumCount: "0", artistCount: "0",
  });
  let cands: any[] = [];
  if (resp?._xml) {
    cands = parseXmlChildren(resp._xml, "song");
  } else {
    const raw = resp?.searchResult3?.song || [];
    cands = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  let best: any = null;
  let bestScore = 0;
  for (const cand of cands) {
    const sc = scorePushCandidate({ titleN, artistN, duration }, cand);
    if (sc > bestScore) { bestScore = sc; best = cand; }
  }
  const id = bestScore >= PUSH_MATCH_THRESHOLD ? (jget(best, "id") || null) : null;
  pushMatchCache.set(cacheKey, id);
  return id ? { id, score: bestScore } : null;
}

// Local /rest reads (session-signed). EdgeSonic answers XML; the attribute
// parser above handles it.
async function localFetchXml(path: string, params?: Record<string, string>): Promise<string> {
  const resp = await fetch(restUrl(path, params));
  return resp.text();
}

function upstreamOk(resp: any): boolean {
  if (resp?._xml) return /status="ok"/.test(resp._xml);
  return resp?.status === "ok";
}

// createPlaylist needs repeated songId params, which the Record-based helper
// can't express — build the query directly.
async function upstreamCreatePlaylist(name: string, songIds: string[]): Promise<boolean> {
  const sp = cloneSignedParams({ name });
  for (const id of songIds) sp.append("songId", id);
  const base = cloneForm.value.url.replace(/\/+$/, "");
  const resp = await fetch(`${base}/rest/createPlaylist?${sp.toString()}`);
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    return (json?.["subsonic-response"] ?? json)?.status === "ok";
  } catch {
    return /status="ok"/.test(text);
  }
}

async function pushStarredStage() {
  const stage = pushStages.value.starred;
  stage.status = "running";
  const xml = await localFetchXml("getStarred2");
  const songs = parseXmlChildren(xml, "song");
  stage.total = songs.length;
  cloneLogPush(`push starred: ${songs.length} local starred song(s)`);
  for (const s of songs) {
    if (pushCancelRequested.value) break;
    try {
      const m = await matchUpstreamSong(s.title, s.artist, numOr(s.duration, null));
      if (!m) {
        stage.failed++;
        cloneLogPush(`push starred: ？ no confident match — ${s.artist || "?"} — ${s.title || "?"}`);
        continue;
      }
      const resp = await cloneFetchJson("star", { id: m.id });
      if (!upstreamOk(resp)) throw new Error("upstream star rejected");
      stage.done++;
      cloneLogPush(`push starred: ✓ ${s.title} → ${m.id}`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`push starred: ✗ ${s.title || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = pushCancelRequested.value ? "skipped" : "done";
}

async function pushPlaylistsStage() {
  const stage = pushStages.value.playlists;
  stage.status = "running";

  // Same-name playlists upstream are skipped, not merged — merging would need
  // a diff against upstream entries and risks clobbering someone's edits.
  const upResp = await cloneFetchJson("getPlaylists");
  let upNames: string[] = [];
  if (upResp?._xml) {
    upNames = parseXmlChildren(upResp._xml, "playlist").map((p) => p.name || "");
  } else {
    const raw = upResp?.playlists?.playlist || [];
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    upNames = arr.map((p: any) => jget(p, "name") || "");
  }
  const existing = new Set(upNames.map((n) => n.toLowerCase()).filter(Boolean));

  const xml = await localFetchXml("getPlaylists");
  const playlists = parseXmlChildren(xml, "playlist");
  stage.total = playlists.length;
  cloneLogPush(`push playlists: ${playlists.length} local playlist(s)`);

  for (const p of playlists) {
    if (pushCancelRequested.value) break;
    const name = p.name || "Untitled";
    try {
      if (existing.has(name.toLowerCase())) {
        stage.done++;
        cloneLogPush(`push playlists: → ${name} already exists upstream, skipped`);
        continue;
      }
      const detailXml = await localFetchXml("getPlaylist", { id: p.id });
      const entries = parseXmlChildren(detailXml, "entry");
      const ids: string[] = [];
      let missed = 0;
      for (const e of entries) {
        if (pushCancelRequested.value) break;
        const m = await matchUpstreamSong(e.title, e.artist, numOr(e.duration, null));
        if (m) ids.push(m.id);
        else {
          missed++;
          cloneLogPush(`push playlists: ？ ${name}: no match — ${e.artist || "?"} — ${e.title || "?"}`);
        }
      }
      if (pushCancelRequested.value) break;
      if (ids.length === 0) {
        stage.failed++;
        cloneLogPush(`push playlists: ✗ ${name} — 0/${entries.length} matched, not created`);
        continue;
      }
      if (!(await upstreamCreatePlaylist(name, ids))) throw new Error("upstream createPlaylist rejected");
      stage.done++;
      cloneLogPush(`push playlists: ✓ ${name} (${ids.length}/${entries.length} matched${missed ? `, ${missed} missed` : ""})`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`push playlists: ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = pushCancelRequested.value ? "skipped" : "done";
}

async function runPush() {
  if (!isSuperAdmin.value || pushRunning.value || cloneRunning.value) return;
  if (!cloneForm.value.url || !cloneForm.value.username || !cloneForm.value.password) {
    showToast(t("settings.common.clone.missingFields"), "error");
    return;
  }
  pushRunning.value = true;
  pushCancelRequested.value = false;
  pushMatchCache.clear();
  for (const k of Object.keys(pushStages.value) as Array<keyof typeof pushStages.value>) {
    pushStages.value[k] = newCloneProgress();
  }
  try {
    await pushStarredStage();
    await pushPlaylistsStage();
    showToast(t("settings.common.clone.done"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.clone.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  pushRunning.value = false;
}

function cancelPush() {
  pushCancelRequested.value = true;
}

function cloneStatusClass(status: CloneProgress["status"]): string {
  switch (status) {
    case "running": return "info";
    case "done":    return "success";
    case "error":   return "error";
    case "skipped": return "muted";
    default:        return "muted";
  }
}
</script>

<template>
  <div class="tools">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("tools.label") }}</div>
        <h1 class="page-title">{{ t("tools.title") }}</h1>
      </div>
    </div>

    <div v-if="!isSuperAdmin" class="empty-state">
      <div class="empty-state-icon">⚿</div>
      <div>{{ t("tools.superAdminOnly") }}</div>
    </div>

    <template v-else>
      <!-- Shared upstream credentials -->
      <div class="card tools-card">
        <div class="sub-header">
          <span class="mono-label">🪞 {{ t("settings.common.clone.title") }}</span>
        </div>
        <div class="transcode-grid">
          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.clone.url") }}</span>
            <input
              v-model="cloneForm.url"
              class="form-input"
              :placeholder="t('settings.common.clone.urlPlaceholder')"
              :disabled="cloneRunning || pushRunning"
              autocomplete="off"
            />
          </label>
          <p class="feature-desc tc-desc">{{ t("settings.common.clone.urlDesc") }}</p>

          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.clone.username") }}</span>
            <input
              v-model="cloneForm.username"
              class="form-input"
              :placeholder="t('settings.common.clone.usernamePlaceholder')"
              :disabled="cloneRunning || pushRunning"
              autocomplete="off"
            />
          </label>

          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.clone.password") }}</span>
            <input
              v-model="cloneForm.password"
              type="password"
              class="form-input"
              :placeholder="t('settings.common.clone.passwordPlaceholder')"
              :disabled="cloneRunning || pushRunning"
              autocomplete="off"
            />
          </label>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>

      <!-- Sub-page tabs -->
      <div class="tool-tabs">
        <button :class="['tool-tab', { active: tab === 'clone' }]" @click="tab = 'clone'">{{ t("tools.tabClone") }}</button>
        <button :class="['tool-tab', { active: tab === 'push' }]" @click="tab = 'push'">{{ t("tools.tabPush") }}</button>
      </div>

      <!-- Sub-page: clone (upstream → local) -->
      <div v-show="tab === 'clone'" class="card tools-card">
        <p class="feature-desc" style="margin: 0 0 0.6rem 0">
          {{ t("settings.common.clone.desc") }}
        </p>
        <div class="transcode-grid">
          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.clone.audioToggle") }}</span>
            <span class="scan-toggle">
              <input type="checkbox" v-model="cloneAudioEnabled" :disabled="cloneRunning" />
              <span>{{ cloneAudioEnabled ? t("common.on") : t("common.off") }}</span>
            </span>
          </label>
          <p class="feature-desc tc-desc">{{ t("settings.common.clone.audioToggleDesc") }}</p>

          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.clone.usersToggle") }}</span>
            <span class="scan-toggle">
              <input type="checkbox" v-model="cloneUsersEnabled" :disabled="cloneRunning" />
              <span>{{ cloneUsersEnabled ? t("common.on") : t("common.off") }}</span>
            </span>
          </label>
          <p class="feature-desc tc-desc">{{ t("settings.common.clone.usersToggleDesc") }}</p>

          <div class="tc-actions">
            <button v-if="!cloneRunning" class="btn-primary" :disabled="pushRunning" @click="runClone">
              {{ t("settings.common.clone.start") }}
            </button>
            <button v-else class="btn-danger" @click="cancelClone">
              {{ t("settings.common.clone.cancel") }}
            </button>
          </div>
        </div>

        <div v-if="cloneRunning || cloneStages.metadata.status !== 'idle'" class="clone-progress">
          <div v-for="key in (['metadata', 'audio', 'playlists', 'starred', 'users'] as const)" :key="key" class="clone-stage-row">
            <span class="clone-stage-label">{{ t(`settings.common.clone.stages.${key}`) }}</span>
            <span class="clone-stage-count">{{ cloneStages[key].done }} / {{ cloneStages[key].total }}</span>
            <span v-if="cloneStages[key].failed" class="clone-stage-failed">✗ {{ cloneStages[key].failed }}</span>
            <span class="status-badge" :class="cloneStatusClass(cloneStages[key].status)">
              {{ t(`settings.common.clone.status.${cloneStages[key].status}`) }}
            </span>
          </div>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>

      <!-- Sub-page: push (local → upstream) -->
      <div v-show="tab === 'push'" class="card tools-card">
        <p class="feature-desc" style="margin: 0 0 0.6rem 0">
          {{ t("settings.common.clone.push.desc") }}
        </p>
        <div class="tc-actions">
          <button v-if="!pushRunning" class="btn-primary" :disabled="cloneRunning" @click="runPush">
            {{ t("settings.common.clone.push.start") }}
          </button>
          <button v-else class="btn-danger" @click="cancelPush">
            {{ t("settings.common.clone.cancel") }}
          </button>
        </div>
        <div v-if="pushRunning || pushStages.starred.status !== 'idle'" class="clone-progress">
          <div v-for="key in (['starred', 'playlists'] as const)" :key="key" class="clone-stage-row">
            <span class="clone-stage-label">{{ t(`settings.common.clone.push.${key}`) }}</span>
            <span class="clone-stage-count">{{ pushStages[key].done }} / {{ pushStages[key].total }}</span>
            <span v-if="pushStages[key].failed" class="clone-stage-failed">✗ {{ pushStages[key].failed }}</span>
            <span class="status-badge" :class="cloneStatusClass(pushStages[key].status)">
              {{ t(`settings.common.clone.status.${pushStages[key].status}`) }}
            </span>
          </div>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>

      <!-- Shared live log -->
      <details v-if="cloneLog.length" class="clone-log card tools-card" open>
        <summary class="mono-label">{{ t("settings.common.clone.log") }}</summary>
        <pre class="clone-log-pre">{{ cloneLog.join("\n") }}</pre>
      </details>
    </template>

    <!-- Toast -->
    <transition name="toast">
      <div v-if="toast.show" class="tools-toast" :class="toast.type">{{ toast.msg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.tools { max-width: 860px; }
.tools-card { padding: 1rem 1.2rem; margin-bottom: 1.1rem; position: relative; }

/* Sub-page tabs */
.tool-tabs { display: flex; gap: 0.5rem; margin-bottom: 1.1rem; }
.tool-tab {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  padding: 0.45rem 1.1rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.tool-tab:hover { color: var(--color-text-primary); }
.tool-tab.active {
  color: var(--color-accent-primary);
  border-color: var(--color-accent-primary);
  background: var(--color-accent-dim);
}

/* Shared with Settings (scoped copies) */
.sub-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.6rem; }
.feature-desc { font-size: var(--fs-sm); color: var(--color-text-secondary); }
.transcode-grid { display: flex; flex-direction: column; gap: 0.65rem; }
.tc-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.tc-key {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
  min-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.tc-row .form-input { flex: 1; min-width: 220px; }
.tc-desc { margin-left: 180px; }
.tc-actions { margin-top: 0.4rem; display: flex; justify-content: flex-end; }
.scan-toggle {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.scan-toggle input { margin: 0; }

/* --- 094 Subsonic clone --- */
.clone-progress {
  margin-top: 0.8rem;
  border-top: 1px dashed var(--color-border-subtle);
  padding-top: 0.6rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.clone-stage-row {
  display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.clone-stage-label {
  color: var(--color-text-primary);
  letter-spacing: 0.05em;
  min-width: 110px;
}
.clone-stage-count {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.clone-stage-failed {
  color: var(--color-accent-primary);
}
.clone-log > summary {
  cursor: pointer;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
}
.clone-log-pre {
  margin: 0.4rem 0 0;
  padding: 0.6rem 0.8rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-secondary);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Toast */
.tools-toast {
  position: fixed;
  bottom: 90px;
  right: 24px;
  z-index: 50;
  padding: 0.6rem 1rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-accent-primary);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.tools-toast.error { border-color: #e5484d; }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; }
</style>
