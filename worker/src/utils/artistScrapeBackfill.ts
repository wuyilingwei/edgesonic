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

// Cron-driven batch backfill: scans artists missing biography / image_url
// and tries each enabled source (netease / qmusic / lastfm) in the admin-
// configured priority order — same resolveArtistInfo() the live getArtistInfo
// path uses, so the cron and the request-time behavior never drift apart.
// High-confidence match only for CN sources — see artistScrapeFallback.ts.
//
// Runs on its own cadence (`feature_strings.artist_scrape_interval_hours`),
// independent of maybeRunMetadataRecheck / maybeRunLrcBackfill. Self-gates
// via `kv_store.cron:last_artist_scrape_ts` so re-runs within the cadence
// are skipped. 0 disables.
import { getFeatureString } from "./features";
import { resolveArtistInfo } from "./artistScrapeFallback";
import { ensureArtistScrapeColumns } from "./schema_patch";

const LAST_RUN_KEY = "cron:last_artist_scrape_ts";
const BATCH_SIZE = 20;

interface ArtistRow {
  id: string;
  name: string;
  biography: string | null;
  image_url: string | null;
}

export async function maybeRunArtistScrapeBackfill(env: Env, _ctx: ExecutionContext): Promise<void> {
  const raw = await getFeatureString(env, "artist_scrape_interval_hours", "24");
  const hours = Math.max(0, Math.floor(Number(raw) || 0));
  if (hours === 0) return; // disabled

  await ensureArtistScrapeColumns(env);

  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  if (hours > 1) {
    const row = await db.prepare("SELECT value FROM kv_store WHERE key = ?")
      .bind(LAST_RUN_KEY)
      .first<{ value: string }>();
    const last = row ? Number(row.value) : 0;
    if (Number.isFinite(last) && last > 0 && now - last < hours * 3600) {
      return; // not yet
    }
  }
  // Stamp BEFORE running — a failure mid-batch shouldn't turn into an
  // every-tick retry storm.
  await db.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(LAST_RUN_KEY, String(now), now).run();

  // Pull a batch of artists missing biography OR image_url. We pick
  // artists that have at least one song_master so we don't waste requests
  // on orphan rows.
  const rows = await db.prepare(
    `SELECT a.id, a.name, a.biography, a.image_url
       FROM artists a
       WHERE (a.biography IS NULL OR a.biography = '' OR a.image_url IS NULL OR a.image_url = '')
         AND EXISTS (SELECT 1 FROM song_masters sm WHERE sm.artist_id = a.id)
       ORDER BY a.updated_at ASC
       LIMIT ?`,
  ).bind(BATCH_SIZE).all<ArtistRow>();

  let filled = 0;
  for (const artist of rows.results || []) {
    const wantBio = !artist.biography;
    const wantCover = !artist.image_url;
    if (!wantBio && !wantCover) continue;
    try {
      const fb = await resolveArtistInfo(env, artist.name, { bio: wantBio, cover: wantCover });
      if (!fb) continue;
      const updates: string[] = [];
      const args: Array<string> = [];
      if (fb.biography && wantBio) {
        updates.push("biography = ?");
        updates.push("biography_source = ?");
        args.push(fb.biography);
        args.push(fb.source);
        filled++;
      }
      if (fb.largeImageUrl && wantCover) {
        updates.push("image_url = ?");
        args.push(fb.largeImageUrl);
        filled++;
      }
      if (updates.length === 0) continue;
      updates.push("updated_at = ?");
      args.push(String(now));
      args.push(artist.id);
      await db.prepare(
        `UPDATE artists SET ${updates.join(", ")} WHERE id = ?`,
      ).bind(...args).run();
    } catch {
      // Best-effort — a transient failure on one artist must not abort the batch.
    }
  }

  return void filled;
}