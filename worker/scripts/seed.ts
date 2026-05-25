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

import { generateId } from "../src/utils/id";
import { createQueries } from "../src/db/queries";

async function main() {
  console.log("EdgeSonic seed script");
  console.log("Run with: wrangler d1 execute edgesonic-db --local --command=\"...\"");
  console.log("Or use the test below in wrangler dev context.\n");

  // Generate sample IDs
  const artistId = await generateId("artist", "standard", 0, "radiohead");
  const albumId = await generateId("album", "standard", 0, artistId + "ok computer");
  const songId = await generateId("song_master", "standard", 0, artistId + "paranoid android" + albumId + "2" + "1");
  const instanceId = await generateId("song_instance", "original", 0, "local" + "r2://music/radiohead/ok-computer/02-paranoid-android.flac" + "flac");

  console.log("Sample IDs:");
  console.log(`  Artist:       ${artistId}`);
  console.log(`  Album:        ${albumId}`);
  console.log(`  Song Master:  ${songId}`);
  console.log(`  Song Instance: ${instanceId}`);

  // Parse back
  const parsed = {
    artist: artistId.substring(0, 8) + "..." + artistId.substring(32),
    album: albumId.substring(0, 8) + "..." + albumId.substring(32),
    song: songId.substring(0, 8) + "..." + songId.substring(32),
    instance: instanceId.substring(0, 8) + "..." + instanceId.substring(32),
  };
  console.log("\nParsed (entity:sub:source):", parsed);

  console.log("\nSQL to seed with wrangler:");
  const now = Math.floor(Date.now() / 1000);
  console.log(`
INSERT INTO users (username, password, level, enabled) VALUES ('admin', 'changeme', 3, 1);
INSERT INTO artists (id, name, sort_name, created_at, updated_at) VALUES ('${artistId}', 'Radiohead', 'radiohead', ${now}, ${now});
INSERT INTO albums (id, name, sort_name, year, genre, song_count, created_at, updated_at) VALUES ('${albumId}', 'OK Computer', 'ok computer', 1997, 'Alternative Rock', 12, ${now}, ${now});
INSERT INTO song_masters (id, album_id, artist_id, title, sort_title, track, disc, duration, genre, participants, created_at, updated_at) VALUES ('${songId}', '${albumId}', '${artistId}', 'Paranoid Android', 'paranoid android', 2, 1, 383, 'Alternative Rock', '{"artist":[{"id":"${artistId}","name":"Radiohead"}],"albumartist":[{"id":"${artistId}","name":"Radiohead"}]}', ${now}, ${now});
INSERT INTO song_instances (id, master_id, source_id, storage_uri, instance_type, suffix, content_type, bit_rate, sample_rate, bit_depth, channels, duration, size, created_at, updated_at) VALUES ('${instanceId}', '${songId}', 'local', 'r2://music/radiohead/ok-computer/02-paranoid-android.flac', 0, 'flac', 'audio/flac', 914, 44100, 16, 2, 383, 28500000, ${now}, ${now});

INSERT INTO user_permissions (level, permission, enabled) VALUES
  (0, 'stream', 0),
  (0, 'download', 0),
  (1, 'stream', 1),
  (1, 'download', 1),
  (1, 'scrobble', 1),
  (2, 'stream', 1),
  (2, 'download', 1),
  (2, 'upload', 1),
  (2, 'scrobble', 1),
  (2, 'manage_library', 1),
  (2, 'manage_sources', 1),
  (3, 'stream', 1),
  (3, 'download', 1),
  (3, 'upload', 1),
  (3, 'scrobble', 1),
  (3, 'manage_library', 1),
  (3, 'manage_sources', 1),
  (3, 'manage_users', 1),
  (2, 'guest_access', 1);
`);
}

main().catch(console.error);
