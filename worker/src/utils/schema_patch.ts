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
