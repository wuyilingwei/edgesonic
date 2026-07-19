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

// Runtime self-heal for the users.nickname column. Schema.sql is the single
// idempotent source of truth (IF NOT EXISTS / INSERT OR IGNORE) and SQLite has
// no "ADD COLUMN IF NOT EXISTS", so a bare ALTER in Schema.sql would fail on
// re-apply. The column therefore lives in the users CREATE TABLE for fresh
// installs and is back-filled here for databases created before it existed.
// Memoized per isolate: at most one ALTER attempt per worker instance.

let ensured = false;
let artistsEnsured = false;

export async function ensureNicknameColumn(env: { DB: D1Database }): Promise<void> {
  if (ensured) return;
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN nickname TEXT").run();
    ensured = true;
  } catch (e) {
    // Column already present → done. Any other error leaves the flag unset so
    // a later request retries rather than silently disabling nicknames.
    if (/duplicate column/i.test(e instanceof Error ? e.message : String(e))) ensured = true;
  }
}

// 0253 — artist biography / image_url / biography_source columns. Same
// idempotent pattern as ensureNicknameColumn: Schema.sql declares them in
// CREATE TABLE for fresh installs; this back-fills existing databases.
export async function ensureArtistScrapeColumns(env: { DB: D1Database }): Promise<void> {
  if (artistsEnsured) return;
  const cols: Array<[string, string]> = [
    ["image_url", "TEXT"],
    ["biography", "TEXT"],
    ["biography_source", "TEXT"],
  ];
  let allDone = true;
  for (const [col, type] of cols) {
    try {
      await env.DB.prepare(`ALTER TABLE artists ADD COLUMN ${col} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) {
        allDone = false;
      }
    }
  }
  if (allDone) artistsEnsured = true;
}

// 0259 — song_masters.lyrics_rich column. Stores the JSON-serialized
// RichLyrics payload (cueLine/cue/agents) produced from TTML/KRC/enhanced
// LRC sidecars or NetEase klyric. NULL when only line-level LRC is
// available; the getLyricsBySongId endpoint degrades to lyrics then.
let richLyricsEnsured = false;
export async function ensureRichLyricsColumn(env: { DB: D1Database }): Promise<void> {
  if (richLyricsEnsured) return;
  try {
    await env.DB.prepare("ALTER TABLE song_masters ADD COLUMN lyrics_rich TEXT").run();
    richLyricsEnsured = true;
  } catch (e) {
    if (/duplicate column/i.test(e instanceof Error ? e.message : String(e))) richLyricsEnsured = true;
  }
}

// storage_sources.cache_tier (per-source hot-cache tier selector) and
// song_instances.last_accessed_at (LRU key for evictForRoom). Same idempotent
// self-heal pattern: both columns are declared in Schema.sql's CREATE TABLE
// for fresh installs; this back-fills databases created before these columns existed.
let cacheTierColumnsEnsured = false;
export async function ensureCacheTierColumns(env: { DB: D1Database }): Promise<void> {
  if (cacheTierColumnsEnsured) return;
  const alters: string[] = [
    "ALTER TABLE storage_sources ADD COLUMN cache_tier TEXT NOT NULL DEFAULT 'off' CHECK (cache_tier IN ('off', 'standard', 'extended'))",
    "ALTER TABLE song_instances ADD COLUMN last_accessed_at INTEGER",
  ];
  let allDone = true;
  for (const sql of alters) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) allDone = false;
    }
  }
  if (allDone) cacheTierColumnsEnsured = true;
}
