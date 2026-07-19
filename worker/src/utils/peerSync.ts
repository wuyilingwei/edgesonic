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

// Per-user one-peer sync of favourites (stars) and playlists between this
// EdgeSonic and one other Subsonic-compatible server the user configures.
//
// Two one-way channels together form a two-way sync (mirroring how the user
// described it):
//   • OUTBOUND (real-time): a local star/unstar/playlist change pushes to the
//     peer immediately (best-effort, via ctx.waitUntil at the call site).
//   • INBOUND (hourly cron): pull the peer's current stars/playlists and apply
//     the delta since last run to the local library.
//
// Loop safety: OUTBOUND compares the peer's current state before writing and
// skips no-ops, so A→B→A terminates. INBOUND writes straight to D1 (never
// through the /star or /createPlaylist HTTP handlers), so applying a pulled
// change never re-triggers an outbound push.
//
// Cross-server song identity: IDs differ per server, so songs are matched by
// title + artist (+ duration tolerance) via the peer's search3.

import { md5 } from "./md5";
import { createQueries } from "../db/queries";

const SYNC_LAST_TS_KEY = "cron:last_peer_sync_ts";

export type PlaylistScope = "own" | "own_public" | "custom";

export interface SyncConfig {
  enabled: boolean;
  url: string;      // peer base URL, no trailing slash, no /rest
  username: string;
  password: string;
  playlistScope: PlaylistScope;
  // For "custom": playlist names to sync (normalised compared case-insensitively).
  playlistNames: string[];
}

interface PeerSong { id: string; title: string; artist: string; duration: number | null }
interface LocalSong { id: string; title: string; artist: string; duration: number | null }

// ── config (user_settings) ──────────────────────────────────────────────────

const SYNC_KEYS = [
  "sync_peer_url",
  "sync_peer_username",
  "sync_peer_password",
  "sync_peer_enabled",
  "sync_peer_playlist_scope",
  "sync_peer_playlist_names",
] as const;

export async function loadSyncConfig(db: D1Database, username: string): Promise<SyncConfig | null> {
  const rows = await db
    .prepare(`SELECT key, value FROM user_settings WHERE username = ? AND key IN (${SYNC_KEYS.map(() => "?").join(",")})`)
    .bind(username, ...SYNC_KEYS)
    .all<{ key: string; value: string }>();
  const m: Record<string, string> = {};
  for (const r of rows.results) m[r.key] = r.value;
  const url = (m.sync_peer_url || "").replace(/\/+$/, "").replace(/\/rest$/, "");
  const scope: PlaylistScope =
    m.sync_peer_playlist_scope === "own_public" || m.sync_peer_playlist_scope === "custom"
      ? m.sync_peer_playlist_scope
      : "own";
  let playlistNames: string[] = [];
  if (m.sync_peer_playlist_names) {
    try { const a = JSON.parse(m.sync_peer_playlist_names); if (Array.isArray(a)) playlistNames = a.map((x) => String(x)); }
    catch { /* corrupt → empty */ }
  }
  const config: SyncConfig = {
    enabled: m.sync_peer_enabled === "1",
    url,
    username: m.sync_peer_username || "",
    password: m.sync_peer_password || "",
    playlistScope: scope,
    playlistNames,
  };
  if (!config.url || !config.username || !config.password) return null;
  return config;
}

// Decide whether a playlist (described by its owner/public flag + name) should
// be synced under the configured scope. Used by both outbound and inbound.
export function shouldSyncPlaylist(cfg: SyncConfig, ownerIsLocalUser: boolean, isPublic: boolean, name: string): boolean {
  if (cfg.playlistScope === "own") return ownerIsLocalUser;
  if (cfg.playlistScope === "own_public") return ownerIsLocalUser || isPublic;
  // custom: match by normalised name against the configured allow-list
  const nn = norm(name);
  return cfg.playlistNames.some((n) => norm(n) === nn);
}

async function loadSnapshot(db: D1Database, username: string): Promise<{ stars: string[]; playlists: Record<string, string[]> }> {
  const row = await db.prepare("SELECT value FROM user_settings WHERE username = ? AND key = 'sync_peer_snapshot'").bind(username).first<{ value: string }>();
  try {
    const parsed = row?.value ? JSON.parse(row.value) : null;
    if (parsed && typeof parsed === "object") {
      return { stars: Array.isArray(parsed.stars) ? parsed.stars : [], playlists: parsed.playlists && typeof parsed.playlists === "object" ? parsed.playlists : {} };
    }
  } catch { /* corrupt snapshot → treat as empty */ }
  return { stars: [], playlists: {} };
}

async function saveSnapshot(db: D1Database, username: string, snap: { stars: string[]; playlists: Record<string, string[]> }): Promise<void> {
  await db.prepare(
    "INSERT INTO user_settings (username, key, value, updated_at) VALUES (?, 'sync_peer_snapshot', ?, ?) ON CONFLICT(username, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(username, JSON.stringify(snap), Math.floor(Date.now() / 1000)).run();
}

// snapshot.playlists maps a normalised playlist name → sorted song keys
// (title|artist). Using the name as the key mirrors how outbound matches an
// existing peer playlist, so the inbound diff is symmetric.
function playlistKey(name: string): string {
  return norm(name);
}

// ── signed Subsonic client for the peer ─────────────────────────────────────

function salt(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

async function peerCall(
  cfg: SyncConfig,
  method: string,
  params: Record<string, string | string[]> = {},
): Promise<Record<string, unknown> | null> {
  const s = salt();
  const token = md5(cfg.password + s);
  const qs = new URLSearchParams({ u: cfg.username, t: token, s, v: "1.16.1", c: "EdgeSonic", f: "json" });
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const one of v) qs.append(k, one);
    else qs.append(k, v);
  }
  const resp = await fetch(`${cfg.url}/rest/${method}?${qs.toString()}`, {
    // Advertise our instance in the loop-prevention header (178) so an
    // EdgeSonic peer can break relay loops.
    headers: { "X-OpenSubsonic-Path": "peer-sync" },
  });
  if (!resp.ok) throw new Error(`peer ${method}: HTTP ${resp.status}`);
  const body = await resp.json<{ ["subsonic-response"]?: Record<string, unknown> }>();
  const sr = body["subsonic-response"];
  if (!sr || sr.status !== "ok") {
    const err = sr?.error as { message?: string } | undefined;
    throw new Error(`peer ${method}: ${err?.message || "rejected"}`);
  }
  return sr;
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  return v ? [v as T] : [];
}

// ── cross-server matching ────────────────────────────────────────────────────

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

// Find the peer song id best matching (title, artist, duration). Requires an
// exact-ish title match plus artist agreement; duration (when both known) must
// be within 3s. Returns null when no confident match — never guesses.
async function findPeerSong(cfg: SyncConfig, title: string, artist: string, duration: number | null): Promise<string | null> {
  const sr = await peerCall(cfg, "search3", { query: title, songCount: "20", artistCount: "0", albumCount: "0" });
  const songs = asArray<Record<string, unknown>>((sr?.searchResult3 as Record<string, unknown> | undefined)?.song);
  const nt = norm(title), na = norm(artist);
  let best: { id: string; score: number } | null = null;
  for (const s of songs) {
    const st = norm(String(s.title || ""));
    const sa = norm(String(s.artist || ""));
    if (st !== nt) continue;
    const artistOk = !na || !sa || sa === na || sa.includes(na) || na.includes(sa);
    if (!artistOk) continue;
    if (duration && typeof s.duration === "number" && Math.abs(s.duration - duration) > 3) continue;
    const score = (sa === na ? 2 : 1) + (duration && s.duration === duration ? 1 : 0);
    if (!best || score > best.score) best = { id: String(s.id), score };
  }
  return best?.id ?? null;
}

// ── local reads (direct D1) ──────────────────────────────────────────────────

async function localStarredSongs(db: D1Database, username: string): Promise<LocalSong[]> {
  const rows = await db.prepare(
    `SELECT sm.id AS id, sm.title AS title, ar.name AS artist, sm.duration AS duration
       FROM annotations an
       JOIN song_masters sm ON sm.id = an.item_id
       LEFT JOIN artists ar ON ar.id = sm.artist_id
      WHERE an.user_id = ? AND an.item_type = 'song' AND an.starred = 1`,
  ).bind(username).all<{ id: string; title: string; artist: string | null; duration: number | null }>();
  return rows.results.map((r) => ({ id: r.id, title: r.title, artist: r.artist || "", duration: r.duration }));
}

// Identity key for delta comparison across servers (title|artist).
function songKey(title: string, artist: string): string {
  return `${norm(title)}|${norm(artist)}`;
}

// ── OUTBOUND: local change → peer (real-time, compare-before-write) ──────────

export async function pushStars(db: D1Database, username: string, songIds: string[], starred: boolean): Promise<void> {
  const cfg = await loadSyncConfig(db, username);
  if (!cfg || !cfg.enabled || songIds.length === 0) return;
  const metas = await db.prepare(
    `SELECT sm.id AS id, sm.title AS title, ar.name AS artist, sm.duration AS duration
       FROM song_masters sm LEFT JOIN artists ar ON ar.id = sm.artist_id
      WHERE sm.id IN (${songIds.map(() => "?").join(",")})`,
  ).bind(...songIds).all<{ id: string; title: string; artist: string | null; duration: number | null }>();
  for (const m of metas.results) {
    try {
      const peerId = await findPeerSong(cfg, m.title, m.artist || "", m.duration);
      if (!peerId) continue;
      await peerCall(cfg, starred ? "star" : "unstar", { id: peerId });
    } catch { /* best-effort per song */ }
  }
}

export async function pushPlaylistDeleted(db: D1Database, username: string, name: string, ownerIsLocalUser: boolean, wasPublic: boolean): Promise<void> {
  const cfg = await loadSyncConfig(db, username);
  if (!cfg || !cfg.enabled) return;
  // Scope filter: a deleted playlist carries the meta it had right before
  // deletion, so the caller passes it through. If the now-deleted playlist
  // wouldn't have been synced, we also shouldn't delete it on the peer.
  if (!shouldSyncPlaylist(cfg, ownerIsLocalUser, wasPublic, name)) return;
  try {
    const sr = await peerCall(cfg, "getPlaylists");
    const pls = asArray<Record<string, unknown>>((sr?.playlists as Record<string, unknown> | undefined)?.playlist);
    const target = pls.find((p) => norm(String(p.name || "")) === norm(name));
    if (target) await peerCall(cfg, "deletePlaylist", { id: String(target.id) });
  } catch { /* best-effort */ }
}

// Upsert a playlist (create or replace entries) on the peer, matching songs by
// identity. Used for create/update outbound.
export async function pushPlaylistUpsert(db: D1Database, username: string, playlistId: string): Promise<void> {
  const cfg = await loadSyncConfig(db, username);
  if (!cfg || !cfg.enabled) return;
  try {
    const meta = await db.prepare("SELECT name, owner, public FROM playlists WHERE id = ?").bind(playlistId).first<{ name: string; owner: string; public: number }>();
    if (!meta) return;
    const ownerIsLocalUser = meta.owner === username;
    const isPublic = meta.public === 1;
    if (!shouldSyncPlaylist(cfg, ownerIsLocalUser, isPublic, meta.name)) return;
    const songs = await db.prepare(
      `SELECT sm.id AS id, sm.title AS title, ar.name AS artist, sm.duration AS duration
         FROM playlist_songs ps JOIN song_masters sm ON sm.id = ps.song_master_id
         LEFT JOIN artists ar ON ar.id = sm.artist_id
        WHERE ps.playlist_id = ? ORDER BY ps.position ASC`,
    ).bind(playlistId).all<{ id: string; title: string; artist: string | null; duration: number | null }>();

    const peerIds: string[] = [];
    for (const s of songs.results) {
      const pid = await findPeerSong(cfg, s.title, s.artist || "", s.duration);
      if (pid) peerIds.push(pid);
    }

    const sr = await peerCall(cfg, "getPlaylists");
    const pls = asArray<Record<string, unknown>>((sr?.playlists as Record<string, unknown> | undefined)?.playlist);
    const existing = pls.find((p) => norm(String(p.name || "")) === norm(meta.name));
    if (existing) {
      // Replace: clear then re-add keeps the peer in the local order.
      const detail = await peerCall(cfg, "getPlaylist", { id: String(existing.id) });
      const entryCount = asArray((detail?.playlist as Record<string, unknown> | undefined)?.entry).length;
      const params: Record<string, string | string[]> = { playlistId: String(existing.id) };
      if (peerIds.length) params.songIdToAdd = peerIds;
      if (entryCount) params.songIndexToRemove = Array.from({ length: entryCount }, (_, i) => String(i));
      await peerCall(cfg, "updatePlaylist", params);
    } else {
      await peerCall(cfg, "createPlaylist", { name: meta.name, ...(peerIds.length ? { songId: peerIds } : {}) });
    }
  } catch { /* best-effort */ }
}

// ── INBOUND: peer → local (hourly cron, delta vs stored snapshot) ────────────

async function localStarWrite(db: D1Database, username: string, songId: string, star: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (star) {
    await db.prepare(
      "INSERT INTO annotations (user_id, item_id, item_type, starred, starred_at) VALUES (?, ?, 'song', 1, ?) ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET starred = 1, starred_at = ?",
    ).bind(username, songId, now, now).run();
  } else {
    await db.prepare(
      "UPDATE annotations SET starred = 0, starred_at = NULL WHERE user_id = ? AND item_id = ? AND item_type = 'song'",
    ).bind(username, songId).run();
  }
}

// Match a peer song (title/artist/duration) to a local song id via local search.
async function findLocalSong(db: D1Database, title: string, artist: string, duration: number | null): Promise<string | null> {
  const rows = await db.prepare(
    `SELECT sm.id AS id, ar.name AS artist, sm.duration AS duration
       FROM song_masters sm LEFT JOIN artists ar ON ar.id = sm.artist_id
      WHERE lower(sm.title) = lower(?) LIMIT 20`,
  ).bind(title).all<{ id: string; artist: string | null; duration: number | null }>();
  const na = norm(artist);
  let best: string | null = null;
  for (const r of rows.results) {
    const ra = norm(r.artist || "");
    const artistOk = !na || !ra || ra === na || ra.includes(na) || na.includes(ra);
    if (!artistOk) continue;
    if (duration && r.duration && Math.abs(r.duration - duration) > 3) continue;
    best = r.id;
    if (ra === na) break;
  }
  return best;
}

// ── playlist inbound helpers ────────────────────────────────────────────────

async function localPlaylistByName(db: D1Database, username: string, name: string): Promise<{ id: string; owner: string; public: number } | null> {
  const row = await db.prepare(
    "SELECT id, owner, public FROM playlists WHERE lower(name) = lower(?) AND (owner = ? OR public = 1) LIMIT 1",
  ).bind(name, username).first<{ id: string; owner: string; public: number }>();
  return row ?? null;
}

async function localPlaylistSongKeys(db: D1Database, playlistId: string): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT sm.title AS title, ar.name AS artist
       FROM playlist_songs ps JOIN song_masters sm ON sm.id = ps.song_master_id
       LEFT JOIN artists ar ON ar.id = sm.artist_id
      WHERE ps.playlist_id = ? ORDER BY ps.position ASC`,
  ).bind(playlistId).all<{ title: string; artist: string | null }>();
  return rows.results.map((r) => songKey(r.title, r.artist || ""));
}

// Create or replace a local playlist so its entries mirror the peer's song
// keys. Owns the playlist as the syncing user so they can edit it locally.
async function localPlaylistMirror(db: D1Database, username: string, name: string, peerSongs: PeerSong[], isPublic: boolean): Promise<void> {
  const localIds: string[] = [];
  for (const s of peerSongs) {
    const lid = await findLocalSong(db, s.title, s.artist, s.duration);
    if (lid) localIds.push(lid);
  }
  const existing = await localPlaylistByName(db, username, name);
  const queries = createQueries(db);
  if (existing) {
    // Only mirror if we own it; never mutate another user's playlist even if
    // it's public and named in a custom scope — that would be destructive.
    if (existing.owner !== username) return;
    await queries.replacePlaylistSongs(existing.id, localIds);
    await queries.updatePlaylistMeta(existing.id, { isPublic });
  } else {
    const newId = crypto.randomUUID().substring(0, 12);
    await queries.createPlaylist({ id: newId, name, owner: username, isPublic, songIds: localIds });
  }
}

async function localPlaylistDeleteIfOwned(db: D1Database, username: string, name: string): Promise<void> {
  const existing = await localPlaylistByName(db, username, name);
  if (!existing || existing.owner !== username) return;
  await db.prepare("DELETE FROM playlists WHERE id = ? AND owner = ?").bind(existing.id, username).run();
}

// ── inbound entry ───────────────────────────────────────────────────────────

export async function runInboundSync(db: D1Database, username: string): Promise<{ starsAdded: number; starsRemoved: number; playlistsTouched: number }> {
  const cfg = await loadSyncConfig(db, username);
  if (!cfg || !cfg.enabled) return { starsAdded: 0, starsRemoved: 0, playlistsTouched: 0 };

  const snap = await loadSnapshot(db, username);
  const prevStars = new Set(snap.stars);
  const prevPlaylists: Record<string, string[]> = { ...snap.playlists }; // name-keyed song key lists

  // ── stars ──
  const sr = await peerCall(cfg, "getStarred2");
  const peerSongs = asArray<Record<string, unknown>>((sr?.starred2 as Record<string, unknown> | undefined)?.song)
    .map<PeerSong>((s) => ({ id: String(s.id), title: String(s.title || ""), artist: String(s.artist || ""), duration: typeof s.duration === "number" ? s.duration : null }));
  const peerKeys = new Set(peerSongs.map((s) => songKey(s.title, s.artist)));

  let starsAdded = 0, starsRemoved = 0;

  for (const s of peerSongs) {
    const key = songKey(s.title, s.artist);
    if (prevStars.has(key)) continue;
    const localId = await findLocalSong(db, s.title, s.artist, s.duration);
    if (localId) { await localStarWrite(db, username, localId, true); starsAdded++; }
  }
  for (const key of prevStars) {
    if (peerKeys.has(key)) continue;
    const [title, artist] = key.split("|");
    const localId = await findLocalSong(db, title, artist, null);
    if (localId) { await localStarWrite(db, username, localId, false); starsRemoved++; }
  }

  // ── playlists ──
  // Pull the peer's playlist index, filter by the configured scope, then
  // fetch each entry list. The snapshot stores the previous run's view of
  // each playlist as a sorted song-key list; we diff against the peer's
  // current list and apply create / replace / delete locally.
  let playlistsTouched = 0;
  const nextPlaylists: Record<string, string[]> = {};
  try {
    const plRes = await peerCall(cfg, "getPlaylists");
    const pls = asArray<Record<string, unknown>>((plRes?.playlists as Record<string, unknown> | undefined)?.playlist);
    for (const p of pls) {
      const name = String(p.name || "");
      const ownerIsPeerUser = String(p.owner || "") === cfg.username;
      const isPublic = p.public === true || p.public === 1 || p.public === "1" || p.public === "true";
      if (!shouldSyncPlaylist(cfg, ownerIsPeerUser, isPublic, name)) continue;

      // Fetch entries to diff at song-key granularity.
      const detail = await peerCall(cfg, "getPlaylist", { id: String(p.id) });
      const entries = asArray<Record<string, unknown>>((detail?.playlist as Record<string, unknown> | undefined)?.entry)
        .map<PeerSong>((e) => ({ id: String(e.id), title: String(e.title || ""), artist: String(e.artist || ""), duration: typeof e.duration === "number" ? e.duration : null }));
      const entryKeys = entries.map((e) => songKey(e.title, e.artist));
      entryKeys.sort();
      nextPlaylists[playlistKey(name)] = entryKeys;

      const prev = prevPlaylists[playlistKey(name)] ?? [];
      const same =
        prev.length === entryKeys.length &&
        entryKeys.every((k, i) => k === prev[i]);
      if (same) continue;

      await localPlaylistMirror(db, username, name, entries, isPublic);
      playlistsTouched++;
    }

    // Playlists that vanished on the peer (or fell out of scope) → delete
    // locally, but only the ones we own. Mirror of pushPlaylistDeleted.
    for (const key of Object.keys(prevPlaylists)) {
      if (key in nextPlaylists) continue;
      // Reconstruct the name: snapshot keys are normalised names; the name
      // round-trips best-effort (normalised form used for matching).
      await localPlaylistDeleteIfOwned(db, username, key);
      playlistsTouched++;
    }
  } catch { /* best-effort; star sync already succeeded */ }

  await saveSnapshot(db, username, { stars: Array.from(peerKeys), playlists: nextPlaylists });
  return { starsAdded, starsRemoved, playlistsTouched };
}

// ── cron entry ───────────────────────────────────────────────────────────────

// Hourly reconciliation for every user with sync enabled. Self-gates to at most
// once per hour via cron:last_peer_sync_ts so it's safe to call each tick.
export async function maybeRunPeerSync(env: { DB: D1Database }): Promise<void> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const last = await db.prepare("SELECT value FROM kv_store WHERE key = ?").bind(SYNC_LAST_TS_KEY).first<{ value: string }>();
  if (last && now - parseInt(last.value || "0", 10) < 3600) return;
  // Stamp before dispatching so a failure doesn't retry every tick.
  await db.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(SYNC_LAST_TS_KEY, String(now), now).run();

  const users = await db.prepare("SELECT DISTINCT username FROM user_settings WHERE key = 'sync_peer_enabled' AND value = '1'").all<{ username: string }>();
  for (const u of users.results) {
    try { await runInboundSync(db, u.username); }
    catch (e) { console.error(`peer sync failed for ${u.username}:`, e); }
  }
}
