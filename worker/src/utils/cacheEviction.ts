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

// cron-driven cache TTL sweep. hotcache.ts's evictExpired/evictForRoom
// only run when a source actually gets a new cache write, so a source that's
// under budget but has stale (past-TTL) cached rows would otherwise never
// have them reclaimed until its next play. This tick walks every source with
// cache_tier != 'off' and clears anything past its hard TTL, independent of
// whether new writes are happening — space gets freed proactively, not only
// reactively at write-time.
//
// No cadence gate (unlike lrcBackfill/metadataRecheck): each tick is one
// cheap SELECT over storage_sources plus a bounded DELETE per source with
// actual expired rows, and running it every tick keeps reclaimed space
// available sooner. Safe to call on every scheduled() invocation.

import { evictExpired } from "./cacheTiers";
import { ensureCacheTierColumns } from "./schema_patch";

export interface CacheEvictionResult {
  sourcesSwept: number;
  rowsEvicted: number;
}

export async function maybeRunCacheEviction(env: Env, _ctx: ExecutionContext): Promise<CacheEvictionResult> {
  await ensureCacheTierColumns(env);
  const sources = await env.DB.prepare(
    "SELECT id FROM storage_sources WHERE cache_tier != 'off'",
  ).all<{ id: string }>();

  const now = Math.floor(Date.now() / 1000);
  let rowsEvicted = 0;
  for (const { id } of sources.results ?? []) {
    rowsEvicted += await evictExpired(env, id, now);
  }
  return { sourcesSwept: sources.results?.length ?? 0, rowsEvicted };
}
