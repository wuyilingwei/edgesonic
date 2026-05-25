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

export interface Artist {
  id: string;
  name: string;
  sort_name: string | null;
  image_r2_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface Album {
  id: string;
  name: string;
  sort_name: string | null;
  year: number | null;
  genre: string | null;
  cover_r2_key: string | null;
  song_count: number;
  duration: number;
  size: number;
  compilation: number;
  created_at: number;
  updated_at: number;
}

export interface SongMaster {
  id: string;
  album_id: string;
  artist_id: string;
  album_artist_id: string | null;
  title: string;
  sort_title: string | null;
  track: number | null;
  disc: number | null;
  duration: number | null;
  genre: string | null;
  compilation: number;
  participants: string | null;
  created_at: number;
  updated_at: number;
}

export interface SongInstance {
  id: string;
  master_id: string;
  source_id: string;
  original_id: string | null;
  storage_uri: string;
  instance_type: number;
  suffix: string;
  content_type: string | null;
  bit_rate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  duration: number | null;
  size: number | null;
  missing: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Annotation {
  user_id: string;
  item_id: string;
  item_type: string;
  play_count: number;
  play_date: number | null;
  rating: number | null;
  starred: number;
  starred_at: number | null;
}

export interface User {
  username: string;
  password: string;
  level: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface StorageSource {
  id: string;
  type: string;
  base_url: string;
  username: string | null;
  password: string | null;
  last_sync: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Playlist {
  id: string;
  name: string;
  owner: string;
  public: number;
  created_at: number;
  updated_at: number;
}
