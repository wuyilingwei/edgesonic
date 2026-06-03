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
  source_type: string;           // 'original' | 'transcoded' | 'cached' | 'external'
  source_dedup_key: string | null;
  parent_instance_id: string | null;
  storage_uri: string;
  transcode_profile: string | null;
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
  password: string;               // aliased from master_password in queries
  level: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Session {
  id: string;
  username: string;
  token: string;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: number;
  created_at: number;
}

export interface SubsonicCredential {
  id: string;
  username: string;
  password: string;
  label: string | null;
  last_used: number | null;
  created_at: number;
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
