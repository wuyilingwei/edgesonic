// SPDX-License-Identifier: AGPL-3.0-or-later
import { md5 } from "./md5";

export interface ArtistCredit {
  id: string;
  name: string;
  position: number;
}

export function parseArtistCredits(value: string | null | undefined): ArtistCredit[] {
  const names = (value || "Unknown Artist")
    .split(/[,，;；/]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const unique = new Map<string, string>();
  for (const name of names.length ? names : ["Unknown Artist"]) {
    const key = name.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  }
  return Array.from(unique.values(), (name, position) => ({
    id: "ar-" + md5(name).substring(0, 10),
    name,
    position,
  }));
}

export function artistInsertStatements(
  db: D1Database,
  credits: ArtistCredit[],
  now: number,
): D1PreparedStatement[] {
  return credits.map((credit) =>
    db.prepare("INSERT OR IGNORE INTO artists (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(credit.id, credit.name, credit.name.toLowerCase(), now, now)
  );
}

export function songArtistStatements(
  db: D1Database,
  songId: string,
  credits: ArtistCredit[],
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM song_artists WHERE song_id = ?").bind(songId),
    ...credits.map((credit) =>
      db.prepare("INSERT INTO song_artists (song_id, artist_id, position) VALUES (?, ?, ?)")
        .bind(songId, credit.id, credit.position)
    ),
  ];
}

export const UNUSED_ARTIST_CLEANUP_SQL = `DELETE FROM artists
  WHERE NOT EXISTS (SELECT 1 FROM song_masters WHERE artist_id = artists.id OR album_artist_id = artists.id)
    AND NOT EXISTS (SELECT 1 FROM song_artists WHERE artist_id = artists.id)`;
