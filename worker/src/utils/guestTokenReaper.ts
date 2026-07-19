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

// Hourly sweep invoked from the scheduled handler. guest_tokens only ever
// accumulates (INSERT on issue, SELECT on use) — without a reaper the table
// grows forever even though every expired row is useless. This keeps the
// index small and the auth-time lookup cheap. Runs unconditionally each tick
// (cheap single DELETE) so cadence gating isn't worth the complexity.
export async function reapExpiredGuestTokens(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM guest_tokens WHERE expires_at < ?")
    .bind(now)
    .run();
}