import type { Artist, Album, SongMaster, SongInstance, Annotation, User } from "../types/entities";

export function createQueries(db: D1Database) {
  return {
    // Artists
    async getArtists(): Promise<Artist[]> {
      const result = await db.prepare("SELECT * FROM artists ORDER BY sort_name ASC NULLS LAST, name ASC").all<Artist>();
      return result.results;
    },

    async getArtist(id: string): Promise<Artist | null> {
      return db.prepare("SELECT * FROM artists WHERE id = ?").bind(id).first<Artist>();
    },

    // Albums
    async getAlbum(id: string): Promise<Album | null> {
      return db.prepare("SELECT * FROM albums WHERE id = ?").bind(id).first<Album>();
    },

    async getAlbumsByArtist(artistId: string): Promise<Album[]> {
      const masters = await db.prepare(
        "SELECT DISTINCT album_id FROM song_masters WHERE artist_id = ? OR album_artist_id = ?"
      ).bind(artistId, artistId).all<{ album_id: string }>();

      if (masters.results.length === 0) return [];

      const ids = masters.results.map((r) => r.album_id);
      const placeholders = ids.map(() => "?").join(",");
      const result = await db.prepare(
        `SELECT * FROM albums WHERE id IN (${placeholders}) ORDER BY year DESC, sort_name ASC NULLS LAST`
      ).bind(...ids).all<Album>();
      return result.results;
    },

    // Song Masters
    async getSongMaster(id: string): Promise<SongMaster | null> {
      return db.prepare("SELECT * FROM song_masters WHERE id = ?").bind(id).first<SongMaster>();
    },

    async getSongMastersByAlbum(albumId: string): Promise<SongMaster[]> {
      const result = await db.prepare(
        "SELECT * FROM song_masters WHERE album_id = ? ORDER BY disc ASC, track ASC"
      ).bind(albumId).all<SongMaster>();
      return result.results;
    },

    // Song Instances
    async getSongInstances(masterId: string): Promise<SongInstance[]> {
      const result = await db.prepare(
        "SELECT * FROM song_instances WHERE master_id = ? AND missing = 0 ORDER BY bit_rate DESC"
      ).bind(masterId).all<SongInstance>();
      return result.results;
    },

    async getSongInstance(id: string): Promise<SongInstance | null> {
      return db.prepare("SELECT * FROM song_instances WHERE id = ?").bind(id).first<SongInstance>();
    },

    // Search
    async search(query: string, opts: {
      artistCount?: number; artistOffset?: number;
      albumCount?: number; albumOffset?: number;
      songCount?: number; songOffset?: number;
    } = {}): Promise<{ artists: Artist[]; albums: Album[]; songs: SongMaster[] }> {
      const like = `%${query}%`;
      const [artists, albums, songs] = await Promise.all([
        db.prepare(
          "SELECT * FROM artists WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.artistCount ?? 20, opts.artistOffset ?? 0).all<Artist>(),
        db.prepare(
          "SELECT * FROM albums WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.albumCount ?? 20, opts.albumOffset ?? 0).all<Album>(),
        db.prepare(
          "SELECT * FROM song_masters WHERE title LIKE ? ORDER BY sort_title ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.songCount ?? 20, opts.songOffset ?? 0).all<SongMaster>(),
      ]);
      return {
        artists: artists.results,
        albums: albums.results,
        songs: songs.results,
      };
    },

    // Annotations
    async getAnnotation(userId: string, itemId: string, itemType: string): Promise<Annotation | null> {
      return db.prepare(
        "SELECT * FROM annotations WHERE user_id = ? AND item_id = ? AND item_type = ?"
      ).bind(userId, itemId, itemType).first<Annotation>();
    },

    async upsertAnnotation(ann: Annotation): Promise<void> {
      await db.prepare(
        `INSERT INTO annotations (user_id, item_id, item_type, play_count, play_date, rating, starred, starred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
           play_count = excluded.play_count,
           play_date = excluded.play_date,
           rating = excluded.rating,
           starred = excluded.starred,
           starred_at = excluded.starred_at`
      ).bind(ann.user_id, ann.item_id, ann.item_type, ann.play_count, ann.play_date, ann.rating, ann.starred, ann.starred_at).run();
    },

    // Users
    async getUser(username: string): Promise<User | null> {
      return db.prepare("SELECT * FROM users WHERE username = ? AND enabled = 1").bind(username).first<User>();
    },

    // Indexes (getIndexes support)
    async getArtistIndexes(): Promise<Array<{ letter: string; artists: Artist[] }>> {
      const result = await db.prepare(
        "SELECT * FROM artists ORDER BY sort_name ASC NULLS LAST, name ASC"
      ).all<Artist>();

      const groups: Record<string, Artist[]> = {};
      for (const artist of result.results) {
        const letter = (artist.sort_name || artist.name).charAt(0).toUpperCase();
        if (!groups[letter]) groups[letter] = [];
        groups[letter].push(artist);
      }
      return Object.entries(groups).map(([letter, artists]) => ({ letter, artists }));
    },
  };
}
