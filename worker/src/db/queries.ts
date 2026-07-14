import type { Artist, Album, SongMaster, SongInstance, Annotation, User, Playlist, Bookmark, PlayQueue, TranscodeJob, InternetRadioStation, PodcastChannel, PodcastEpisode, Share } from "../types/entities";

export interface SongNames {
  artist_name: string | null;
  album_name: string | null;
}

// onto song_masters rows. Subsonic clients gate playback decisions on
// Child.suffix / contentType / bitRate / size / path, so every song listing
// needs them. Instance preference mirrors getSongInstances: R2 copies first
// (Worker fast path), then highest bit_rate.
export interface SongPhysical {
  inst_suffix: string | null;
  inst_content_type: string | null;
  inst_bit_rate: number | null;
  inst_size: number | null;
  inst_duration: number | null;
  inst_storage_uri: string | null;
}

export type SongRow = SongMaster & SongNames & SongPhysical;

const SONG_ROW_COLS = `sm.*, ar.name AS artist_name, al.name AS album_name,
       si.suffix AS inst_suffix, si.content_type AS inst_content_type,
       si.bit_rate AS inst_bit_rate, si.size AS inst_size,
       si.duration AS inst_duration, si.storage_uri AS inst_storage_uri`;

const SONG_ROW_JOINS = `LEFT JOIN artists ar ON ar.id = sm.artist_id
       LEFT JOIN albums al ON al.id = sm.album_id
       LEFT JOIN song_instances si ON si.id = (
         SELECT id FROM song_instances
         WHERE master_id = sm.id AND missing = 0
         ORDER BY CASE WHEN storage_uri LIKE 'r2://%' THEN 0 ELSE 1 END ASC,
                  bit_rate DESC
         LIMIT 1)`;

export function createQueries(db: D1Database) {
  return {
    // Artists
    async getArtists(): Promise<Artist[]> {
      const result = await db.prepare("SELECT * FROM artists ORDER BY sort_name ASC NULLS LAST, name ASC").all<Artist>();
      return result.results;
    },

    // 164: real COUNT(*) totals for the Dashboard stat tiles — those used to
    // be derived from a capped search3 call (songCount/albumCount:"500"),
    // which silently plateaus at exactly 500 for any library past that size
    // instead of showing the true total.
    async getLibraryCounts(): Promise<{ artists: number; albums: number; songs: number }> {
      const [artists, albums, songs] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM artists").first<{ n: number }>(),
        db.prepare("SELECT COUNT(*) AS n FROM albums").first<{ n: number }>(),
        db.prepare("SELECT COUNT(*) AS n FROM song_masters").first<{ n: number }>(),
      ]);
      return {
        artists: artists?.n ?? 0,
        albums: albums?.n ?? 0,
        songs: songs?.n ?? 0,
      };
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

      // headroom for future fixed params. Multi-batch ORDER BY is reassembled
      // in JS to preserve the same year DESC, sort_name ASC NULLS LAST semantics.
      const ids = Array.from(new Set(masters.results.map((r) => r.album_id)));
      const BATCH = 80;
      const rows: Album[] = [];
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const placeholders = batch.map(() => "?").join(",");
        const result = await db.prepare(
          `SELECT * FROM albums WHERE id IN (${placeholders})`
        ).bind(...batch).all<Album>();
        rows.push(...result.results);
      }
      rows.sort((a, b) => {
        // year DESC NULLS LAST
        const ay = a.year ?? -Infinity;
        const by = b.year ?? -Infinity;
        if (by !== ay) return by - ay;
        // sort_name ASC NULLS LAST
        const an = a.sort_name ?? "￿";
        const bn = b.sort_name ?? "￿";
        return an.localeCompare(bn);
      });
      return rows;
    },

    async listAlbums(
      type: string,
      size: number,
      offset: number,
      opts: {
        fromYear?: number;
        toYear?: number;
        genre?: string;
        musicFolderId?: string;
      } = {},
    ): Promise<Array<Album & { artist_name: string | null; artist_id: string | null }>> {
      // ORDER BY is selected by type. WHERE is composed from opts so any type
      // may be filtered further (genre / musicFolderId / etc).
      let order: string;
      switch (type) {
        case "alphabeticalByName":
          order = "a.sort_name ASC NULLS LAST, a.name ASC";
          break;
        case "alphabeticalByNameDesc":
          order = "a.sort_name DESC NULLS LAST, a.name DESC";
          break;
        case "alphabeticalByArtist":
          // sort by primary artist's sort_name then album name
          order = "artist_sort ASC NULLS LAST, a.sort_name ASC NULLS LAST, a.name ASC";
          break;
        case "random":
          order = "RANDOM()";
          break;
        case "byYear": {
          // Subsonic spec: ascending when fromYear <= toYear, descending otherwise
          const fy = opts.fromYear ?? 0;
          const ty = opts.toYear ?? 9999;
          order = fy <= ty ? "a.year ASC NULLS LAST" : "a.year DESC NULLS LAST";
          break;
        }
        case "byGenre":
          order = "a.sort_name ASC NULLS LAST, a.name ASC";
          break;
        case "highest":
          order = "avg_rating DESC, a.created_at DESC";
          break;
        case "starred":
          order = "starred_at DESC";
          break;
        case "frequent":
          order = "play_count DESC, a.created_at DESC";
          break;
        case "recent":
          order = "play_date DESC, a.created_at DESC";
          break;
        case "oldest":
          order = "a.created_at ASC";
          break;
        // newest / unknown
        default:
          order = "a.created_at DESC";
      }

      const where: string[] = [];
      const binds: unknown[] = [];

      // byYear range
      if (type === "byYear") {
        const fy = opts.fromYear;
        const ty = opts.toYear;
        if (fy !== undefined && ty !== undefined) {
          const lo = Math.min(fy, ty);
          const hi = Math.max(fy, ty);
          where.push("a.year BETWEEN ? AND ?");
          binds.push(lo, hi);
        } else if (fy !== undefined) {
          where.push("a.year >= ?");
          binds.push(fy);
        } else if (ty !== undefined) {
          where.push("a.year <= ?");
          binds.push(ty);
        }
      }

      // Genre — required for byGenre, optional for other types
      const genre = opts.genre;
      if (genre) {
        where.push(
          "(a.genre = ? OR EXISTS (SELECT 1 FROM song_masters sm2 WHERE sm2.album_id = a.id AND sm2.genre = ?))"
        );
        binds.push(genre, genre);
      } else if (type === "byGenre") {
        // byGenre with no genre arg → empty result (Subsonic spec requires genre)
        return [];
      }

      // musicFolderId → restrict to albums whose instances live in that source.
      // Aggregate folder ids ("default" / "0" / "") skip filtering.
      const folder = opts.musicFolderId;
      if (folder && folder !== "default" && folder !== "0") {
        where.push(
          `EXISTS (
            SELECT 1 FROM song_masters sm3
            JOIN song_instances si3 ON si3.master_id = sm3.id
            WHERE sm3.album_id = a.id AND si3.source_id = ?
          )`
        );
        binds.push(folder);
      }

      // starred / frequent / recent additionally require a matching annotation row.
      if (type === "starred") {
        where.push(
          "EXISTS (SELECT 1 FROM annotations an WHERE an.item_id = a.id AND an.item_type = 'album' AND an.starred = 1)"
        );
      }
      if (type === "frequent") {
        where.push(
          "EXISTS (SELECT 1 FROM annotations an WHERE an.item_id = a.id AND an.item_type = 'album' AND an.play_count > 0)"
        );
      }
      if (type === "recent") {
        where.push(
          "EXISTS (SELECT 1 FROM annotations an WHERE an.item_id = a.id AND an.item_type = 'album' AND an.play_date IS NOT NULL)"
        );
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const sql = `
        SELECT a.*,
          (SELECT ar.name FROM song_masters sm JOIN artists ar ON ar.id = sm.artist_id
           WHERE sm.album_id = a.id LIMIT 1) AS artist_name,
          (SELECT ar.sort_name FROM song_masters sm JOIN artists ar ON ar.id = sm.artist_id
           WHERE sm.album_id = a.id LIMIT 1) AS artist_sort,
          (SELECT sm.artist_id FROM song_masters sm WHERE sm.album_id = a.id LIMIT 1) AS artist_id,
          COALESCE((SELECT AVG(an.rating) FROM annotations an
                    WHERE an.item_id = a.id AND an.item_type = 'album' AND an.rating IS NOT NULL), 0) AS avg_rating,
          COALESCE((SELECT SUM(an.play_count) FROM annotations an
                    WHERE an.item_id = a.id AND an.item_type = 'album'), 0) AS play_count,
          (SELECT MAX(an.play_date) FROM annotations an
            WHERE an.item_id = a.id AND an.item_type = 'album') AS play_date,
          (SELECT MAX(an.starred_at) FROM annotations an
            WHERE an.item_id = a.id AND an.item_type = 'album' AND an.starred = 1) AS starred_at
        FROM albums a
        ${whereSql}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `;

      const result = await db.prepare(sql)
        .bind(...binds, size, offset)
        .all<Album & { artist_name: string | null; artist_id: string | null }>();
      return result.results;
    },

    // List all enabled storage sources (for getMusicFolders).
    async listEnabledSources(): Promise<Array<{ id: string; name: string; base_url: string; type: string }>> {
      const result = await db.prepare(
        "SELECT id, name, base_url, type FROM storage_sources WHERE enabled = 1 ORDER BY name ASC, id ASC"
      ).all<{ id: string; name: string; base_url: string; type: string }>();
      return result.results;
    },

    async getGenres(): Promise<Array<{ genre: string; songCount: number; albumCount: number }>> {
      const result = await db.prepare(
        `SELECT genre, COUNT(*) AS songCount, COUNT(DISTINCT album_id) AS albumCount
         FROM song_masters WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY genre ASC`
      ).all<{ genre: string; songCount: number; albumCount: number }>();
      return result.results;
    },

    // other song listing (it fed bare rows to mapSong before).
    async getSongsByGenre(genre: string, count: number, offset: number): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
         WHERE sm.genre = ? ORDER BY sm.sort_title ASC LIMIT ? OFFSET ?`
      ).bind(genre, count, offset).all<SongRow>();
      return result.results;
    },

    // Song Masters
    // spec-required Child.artist / Child.album text fields everywhere.
    async getSongMaster(id: string): Promise<SongRow | null> {
      return db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
         WHERE sm.id = ?`
      ).bind(id).first<SongRow>();
    },

    async getSongMastersByAlbum(albumId: string): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
         WHERE sm.album_id = ? ORDER BY sm.disc ASC, sm.track ASC`
      ).bind(albumId).all<SongRow>();
      return result.results;
    },

    // Fetch song_masters by an arbitrary id list (deduped, order preserved by caller).
    // so callers like /rest/getNowPlaying (KV active streams) and bookmarks
    // listings don't crash with "too many SQL variables" on large inputs.
    async getSongMastersByIds(ids: string[]): Promise<SongRow[]> {
      if (ids.length === 0) return [];
      const uniq = Array.from(new Set(ids));
      const BATCH = 80;
      const rows: SongRow[] = [];
      for (let i = 0; i < uniq.length; i += BATCH) {
        const batch = uniq.slice(i, i + BATCH);
        const placeholders = batch.map(() => "?").join(",");
        const result = await db.prepare(
          `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
           WHERE sm.id IN (${placeholders})`
        ).bind(...batch).all<SongRow>();
        rows.push(...result.results);
      }
      return rows;
    },

    // Song Instances
    async getSongInstances(masterId: string): Promise<SongInstance[]> {
      const result = await db.prepare(
        // instances[0]` default already lands on the R2 copy when present
        // (Worker binding fast path + R2 presign eligible). Within the same
        // source tier, higher bit_rate wins to preserve pre-093 quality
        // preference. media.ts still runs the full selector loop for
        // format/maxBitRate overrides.
        `SELECT * FROM song_instances
         WHERE master_id = ? AND missing = 0
         ORDER BY
           CASE WHEN storage_uri LIKE 'r2://%' THEN 0 ELSE 1 END ASC,
           bit_rate DESC`
      ).bind(masterId).all<SongInstance>();
      return result.results;
    },

    async getSongInstance(id: string): Promise<SongInstance | null> {
      return db.prepare("SELECT * FROM song_instances WHERE id = ?").bind(id).first<SongInstance>();
    },

    // Search — empty query matches everything (Navidrome-compatible full listing)
    async search(query: string, opts: {
      artistCount?: number; artistOffset?: number;
      albumCount?: number; albumOffset?: number;
      songCount?: number; songOffset?: number;
      // 154: EdgeSonic-only extension, not part of the Subsonic spec. Defaults
      // to the original alphabetical order so third-party Subsonic clients
      // (which never send this) see no behavior change; the web Songs tab
      // passes "newest"/"oldest" to browse by library insertion time.
      songSort?: "title" | "titleDesc" | "newest" | "oldest";
    } = {}): Promise<{
      artists: Artist[];
      albums: Album[];
      songs: SongRow[];
    }> {
      const like = `%${query}%`;
      const songOrder = opts.songSort === "newest"
        ? "sm.created_at DESC"
        : opts.songSort === "oldest"
          ? "sm.created_at ASC"
          : opts.songSort === "titleDesc"
            ? "sm.sort_title DESC"
            : "sm.sort_title ASC";
      const [artists, albums, songs] = await Promise.all([
        db.prepare(
          "SELECT * FROM artists WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.artistCount ?? 20, opts.artistOffset ?? 0).all<Artist>(),
        db.prepare(
          "SELECT * FROM albums WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.albumCount ?? 20, opts.albumOffset ?? 0).all<Album>(),
        db.prepare(
          `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
           WHERE sm.title LIKE ? ORDER BY ${songOrder} LIMIT ? OFFSET ?`
        ).bind(like, opts.songCount ?? 20, opts.songOffset ?? 0)
          .all<SongRow>(),
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

    // Returns Map keyed by `${itemType}:${itemId}` → annotation row.
    // Empty `ids` short-circuits to avoid an empty IN(...) query.
    // songCount=500 used to crash with "too many SQL variables at offset 28".
    // Chunk to ≤ 80 ids per query (leaves 2 slots for user_id + item_type).
    async getAnnotationsMap(
      userId: string,
      itemType: "song" | "album" | "artist",
      ids: string[],
    ): Promise<Map<string, Annotation>> {
      const map = new Map<string, Annotation>();
      if (ids.length === 0) return map;
      const uniq = Array.from(new Set(ids));
      const BATCH = 80;
      for (let i = 0; i < uniq.length; i += BATCH) {
        const batch = uniq.slice(i, i + BATCH);
        const placeholders = batch.map(() => "?").join(",");
        const result = await db.prepare(
          `SELECT * FROM annotations
           WHERE user_id = ? AND item_type = ? AND item_id IN (${placeholders})`
        ).bind(userId, itemType, ...batch).all<Annotation>();
        for (const row of result.results) {
          map.set(`${row.item_type}:${row.item_id}`, row);
        }
      }
      return map;
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

    // --- 033: Annotation endpoint helpers ---

    // Set starred=1 + starred_at=now for one item; UPSERT preserves other columns.
    async starItem(userId: string, itemId: string, itemType: "song" | "album" | "artist"): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO annotations (user_id, item_id, item_type, play_count, starred, starred_at)
         VALUES (?, ?, ?, 0, 1, ?)
         ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
           starred = 1,
           starred_at = excluded.starred_at`
      ).bind(userId, itemId, itemType, now).run();
    },

    // Set starred=0 + starred_at=NULL; insert row with defaults if missing.
    async unstarItem(userId: string, itemId: string, itemType: "song" | "album" | "artist"): Promise<void> {
      await db.prepare(
        `INSERT INTO annotations (user_id, item_id, item_type, play_count, starred, starred_at)
         VALUES (?, ?, ?, 0, 0, NULL)
         ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
           starred = 0,
           starred_at = NULL`
      ).bind(userId, itemId, itemType).run();
    },

    // rating 1-5 sets value; rating 0 clears (writes NULL — CHECK constraint forbids 0).
    async setItemRating(
      userId: string,
      itemId: string,
      itemType: "song" | "album" | "artist",
      rating: number,
    ): Promise<void> {
      const value = rating === 0 ? null : rating;
      await db.prepare(
        `INSERT INTO annotations (user_id, item_id, item_type, play_count, rating, starred)
         VALUES (?, ?, ?, 0, ?, 0)
         ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
           rating = excluded.rating`
      ).bind(userId, itemId, itemType, value).run();
    },

    // Increment play_count + write play_date. Always treats item as 'song'.
    async scrobbleSong(userId: string, songId: string, playDateSec: number): Promise<void> {
      await db.prepare(
        `INSERT INTO annotations (user_id, item_id, item_type, play_count, play_date, starred)
         VALUES (?, ?, 'song', 1, ?, 0)
         ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET
           play_count = COALESCE(annotations.play_count, 0) + 1,
           play_date = excluded.play_date`
      ).bind(userId, songId, playDateSec).run();
    },

    // getStarred / getStarred2 — three queries (artist / album / song) joined to entity tables.
    async getStarredArtists(userId: string): Promise<Artist[]> {
      const result = await db.prepare(
        `SELECT ar.* FROM artists ar
         JOIN annotations an ON an.item_id = ar.id AND an.item_type = 'artist'
         WHERE an.user_id = ? AND an.starred = 1
         ORDER BY an.starred_at DESC`
      ).bind(userId).all<Artist>();
      return result.results;
    },

    async getStarredAlbums(
      userId: string,
    ): Promise<Array<Album & { artist_name: string | null; artist_id: string | null }>> {
      const result = await db.prepare(
        `SELECT al.*,
           (SELECT ar.name FROM song_masters sm JOIN artists ar ON ar.id = sm.artist_id
            WHERE sm.album_id = al.id LIMIT 1) AS artist_name,
           (SELECT sm.artist_id FROM song_masters sm WHERE sm.album_id = al.id LIMIT 1) AS artist_id
         FROM albums al
         JOIN annotations an ON an.item_id = al.id AND an.item_type = 'album'
         WHERE an.user_id = ? AND an.starred = 1
         ORDER BY an.starred_at DESC`
      ).bind(userId).all<Album & { artist_name: string | null; artist_id: string | null }>();
      return result.results;
    },

    async getStarredSongs(userId: string): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS}
         FROM song_masters sm
         JOIN annotations an ON an.item_id = sm.id AND an.item_type = 'song'
         ${SONG_ROW_JOINS}
         WHERE an.user_id = ? AND an.starred = 1
         ORDER BY an.starred_at DESC`
      ).bind(userId).all<SongRow>();
      return result.results;
    },

    // getRandomSongs — D1 ORDER BY RANDOM() with optional genre / year filter.
    // year filter joins albums.year (song_masters has no year column).
    async getRandomSongs(opts: {
      size: number;
      genre?: string;
      fromYear?: number;
      toYear?: number;
    }): Promise<SongRow[]> {
      const where: string[] = [];
      const binds: unknown[] = [];
      if (opts.genre) {
        where.push("sm.genre = ?");
        binds.push(opts.genre);
      }
      if (opts.fromYear !== undefined) {
        where.push("al.year >= ?");
        binds.push(opts.fromYear);
      }
      if (opts.toYear !== undefined) {
        where.push("al.year <= ?");
        binds.push(opts.toYear);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      binds.push(opts.size);
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM song_masters sm ${SONG_ROW_JOINS}
         ${whereSql}
         ORDER BY RANDOM() LIMIT ?`
      ).bind(...binds).all<SongRow>();
      return result.results;
    },

    // across ALL users (catalog-level ranking, mirrors list_albums "frequent").
    // LIKE match on artist name so we tolerate sort_name / canonical variants
    // (last.fm uses the same artist param the client supplied).
    // Ties broken by created_at DESC so newer rips bubble up.
    async getTopSongsByArtist(
      artistName: string,
      limit: number,
    ): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS},
                COALESCE(SUM(an.play_count), 0) AS total_plays
         FROM song_masters sm
         JOIN artists ar ON ar.id = sm.artist_id
         LEFT JOIN albums al ON al.id = sm.album_id
         LEFT JOIN song_instances si ON si.id = (
           SELECT id FROM song_instances
           WHERE master_id = sm.id AND missing = 0
           ORDER BY CASE WHEN storage_uri LIKE 'r2://%' THEN 0 ELSE 1 END ASC,
                    bit_rate DESC
           LIMIT 1)
         LEFT JOIN annotations an
           ON an.item_id = sm.id AND an.item_type = 'song'
         WHERE LOWER(ar.name) = LOWER(?) OR ar.name LIKE ?
         GROUP BY sm.id
         ORDER BY total_plays DESC, sm.created_at DESC
         LIMIT ?`
      ).bind(artistName, artistName, limit)
        .all<SongRow & { total_plays: number }>();
      return result.results;
    },

    // Users
    async getUser(username: string): Promise<User | null> {
      return db.prepare("SELECT username, master_password AS password, level, enabled, created_at, updated_at FROM users WHERE username = ? AND enabled = 1").bind(username).first<User>();
    },

    // Playlists
    async getPlaylistsForUser(username: string): Promise<Playlist[]> {
      const result = await db.prepare(
        "SELECT * FROM playlists WHERE owner = ? OR public = 1 ORDER BY updated_at DESC"
      ).bind(username).all<Playlist>();
      return result.results;
    },

    async getPlaylistById(id: string): Promise<Playlist | null> {
      return db.prepare("SELECT * FROM playlists WHERE id = ?").bind(id).first<Playlist>();
    },

    // Physical instance columns included so playlist entries carry the
    // spec's Child.path/suffix/contentType/size like every other listing.
    async getPlaylistSongs(playlistId: string): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM playlist_songs ps
         JOIN song_masters sm ON sm.id = ps.song_master_id
         ${SONG_ROW_JOINS}
         WHERE ps.playlist_id = ? ORDER BY ps.position ASC`
      ).bind(playlistId).all<SongRow>();
      return result.results;
    },

    async createPlaylist(opts: { id: string; name: string; owner: string; isPublic?: boolean; songIds?: string[] }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const songIds = opts.songIds ?? [];
      const totals = await computePlaylistTotals(db, songIds);

      const stmts: D1PreparedStatement[] = [
        db.prepare(
          "INSERT INTO playlists (id, name, owner, public, song_count, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(opts.id, opts.name, opts.owner, opts.isPublic ? 1 : 0, totals.count, totals.duration, now, now),
      ];
      songIds.forEach((sid, i) => {
        stmts.push(
          db.prepare(
            "INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)"
          ).bind(opts.id, sid, i, now)
        );
      });
      await db.batch(stmts);
    },

    async replacePlaylistSongs(playlistId: string, songIds: string[]): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const totals = await computePlaylistTotals(db, songIds);
      const stmts: D1PreparedStatement[] = [
        db.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").bind(playlistId),
      ];
      songIds.forEach((sid, i) => {
        stmts.push(
          db.prepare(
            "INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)"
          ).bind(playlistId, sid, i, now)
        );
      });
      stmts.push(
        db.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
          .bind(totals.count, totals.duration, now, playlistId)
      );
      await db.batch(stmts);
    },

    async updatePlaylistMeta(id: string, patch: { name?: string; comment?: string | null; isPublic?: boolean }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.name !== undefined) { sets.push("name = ?"); binds.push(patch.name); }
      if (patch.comment !== undefined) { sets.push("comment = ?"); binds.push(patch.comment); }
      if (patch.isPublic !== undefined) { sets.push("public = ?"); binds.push(patch.isPublic ? 1 : 0); }
      if (sets.length === 0) return;
      sets.push("updated_at = ?");
      binds.push(Math.floor(Date.now() / 1000));
      binds.push(id);
      await db.prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    },

    async addSongsToPlaylist(playlistId: string, songIds: string[]): Promise<void> {
      if (songIds.length === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const maxRow = await db.prepare(
        "SELECT COALESCE(MAX(position), -1) AS maxPos FROM playlist_songs WHERE playlist_id = ?"
      ).bind(playlistId).first<{ maxPos: number }>();
      const start = (maxRow?.maxPos ?? -1) + 1;
      const stmts: D1PreparedStatement[] = songIds.map((sid, i) =>
        db.prepare(
          "INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)"
        ).bind(playlistId, sid, start + i, now)
      );
      await db.batch(stmts);
      await recalcPlaylistStats(db, playlistId, now);
    },

    async removeSongsFromPlaylist(playlistId: string, indices: number[]): Promise<void> {
      if (indices.length === 0) return;
      // Subsonic semantics: songIndexToRemove is the position within the playlist.
      // Pull all rows, drop the requested indices, rewrite positions.
      const existing = await db.prepare(
        "SELECT song_master_id, position FROM playlist_songs WHERE playlist_id = ? ORDER BY position ASC"
      ).bind(playlistId).all<{ song_master_id: string; position: number }>();

      const toRemove = new Set(indices);
      const survivors = existing.results.filter((_, idx) => !toRemove.has(idx));

      const now = Math.floor(Date.now() / 1000);
      const stmts: D1PreparedStatement[] = [
        db.prepare("DELETE FROM playlist_songs WHERE playlist_id = ?").bind(playlistId),
      ];
      survivors.forEach((row, i) => {
        stmts.push(
          db.prepare(
            "INSERT INTO playlist_songs (playlist_id, song_master_id, position, added_at) VALUES (?, ?, ?, ?)"
          ).bind(playlistId, row.song_master_id, i, now)
        );
      });
      await db.batch(stmts);
      await recalcPlaylistStats(db, playlistId, now);
    },

    async deletePlaylist(id: string): Promise<void> {
      // CASCADE on playlist_songs handles entries.
      await db.prepare("DELETE FROM playlists WHERE id = ?").bind(id).run();
    },

    // ========================================================================
    // ========================================================================
    async getBookmarksByUser(username: string): Promise<Bookmark[]> {
      const result = await db.prepare(
        "SELECT * FROM bookmarks WHERE user_id = ? ORDER BY updated_at DESC"
      ).bind(username).all<Bookmark>();
      return result.results;
    },

    async upsertBookmark(opts: {
      username: string;
      songMasterId: string;
      positionMs: number;
      comment?: string | null;
    }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const comment = opts.comment ?? null;
      await db.prepare(
        `INSERT INTO bookmarks (user_id, song_master_id, position_ms, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, song_master_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           comment = excluded.comment,
           updated_at = excluded.updated_at`
      ).bind(opts.username, opts.songMasterId, opts.positionMs, comment, now, now).run();
    },

    async deleteBookmark(username: string, songMasterId: string): Promise<void> {
      await db.prepare(
        "DELETE FROM bookmarks WHERE user_id = ? AND song_master_id = ?"
      ).bind(username, songMasterId).run();
    },

    // ========================================================================
    // ========================================================================
    async getPlayQueue(username: string): Promise<PlayQueue | null> {
      return db.prepare(
        "SELECT * FROM play_queues WHERE user_id = ?"
      ).bind(username).first<PlayQueue>();
    },

    async savePlayQueue(opts: {
      username: string;
      songIds: string[];                  // queue order; stored as JSON
      currentId?: string | null;
      positionMs?: number;
      changedBy?: string | null;
    }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const songIdsJson = JSON.stringify(opts.songIds);
      const currentId = opts.currentId ?? null;
      const positionMs = opts.positionMs ?? 0;
      const changedBy = opts.changedBy ?? null;
      await db.prepare(
        `INSERT INTO play_queues (user_id, song_ids, current_id, position_ms, changed_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           song_ids = excluded.song_ids,
           current_id = excluded.current_id,
           position_ms = excluded.position_ms,
           changed_by = excluded.changed_by,
           updated_at = excluded.updated_at`
      ).bind(opts.username, songIdsJson, currentId, positionMs, changedBy, now).run();
    },

    // ========================================================================
    // ========================================================================
    // Each share is owned by one user; cascade deletes wipe entries when the
    // share or owner is removed. `getSharesForUser(username, isAdmin)` returns
    // the caller's own shares (or every share when isAdmin=true so the
    // SuperAdmin Settings view can audit).
    async getSharesForUser(username: string, isAdmin = false): Promise<Share[]> {
      if (isAdmin) {
        const result = await db.prepare(
          "SELECT * FROM shares ORDER BY updated_at DESC"
        ).all<Share>();
        return result.results;
      }
      const result = await db.prepare(
        "SELECT * FROM shares WHERE user_id = ? ORDER BY updated_at DESC"
      ).bind(username).all<Share>();
      return result.results;
    },

    async getShareById(id: string): Promise<Share | null> {
      return db.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first<Share>();
    },

    // Physical instance columns included so share entries carry the spec's
    // Child.path/suffix/contentType/size like every other listing.
    async getShareEntries(shareId: string): Promise<SongRow[]> {
      const result = await db.prepare(
        `SELECT ${SONG_ROW_COLS} FROM share_entries se
         JOIN song_masters sm ON sm.id = se.song_master_id
         ${SONG_ROW_JOINS}
         WHERE se.share_id = ? ORDER BY se.position ASC`
      ).bind(shareId).all<SongRow>();
      return result.results;
    },

    async createShare(opts: {
      id: string;
      userId: string;
      description?: string | null;
      expiresAt?: number | null;            // unix seconds; null = never expires
      songIds: string[];                    // ordered target song_master ids
    }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const description = opts.description ?? null;
      const expiresAt = opts.expiresAt ?? null;
      const stmts: D1PreparedStatement[] = [
        db.prepare(
          `INSERT INTO shares (id, user_id, description, expires_at, view_count, last_visited_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`
        ).bind(opts.id, opts.userId, description, expiresAt, now, now),
      ];
      opts.songIds.forEach((sid, i) => {
        stmts.push(
          db.prepare(
            "INSERT INTO share_entries (share_id, position, song_master_id) VALUES (?, ?, ?)"
          ).bind(opts.id, i, sid)
        );
      });
      await db.batch(stmts);
    },

    async updateShareMeta(id: string, patch: {
      description?: string | null;          // empty string is treated as clear (null)
      expiresAt?: number | null;            // unix seconds; null = clear
    }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.description !== undefined) { sets.push("description = ?"); binds.push(patch.description); }
      if (patch.expiresAt !== undefined) { sets.push("expires_at = ?"); binds.push(patch.expiresAt); }
      if (sets.length === 0) return;
      sets.push("updated_at = ?");
      binds.push(Math.floor(Date.now() / 1000));
      binds.push(id);
      await db.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    },

    async deleteShare(id: string): Promise<void> {
      // CASCADE on share_entries handles entries.
      await db.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
    },

    // Atomic +1 + last_visited_at = now. Called by the public /share/:id route
    // after the existence + expiry checks pass.
    async incrementShareView(id: string): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        "UPDATE shares SET view_count = view_count + 1, last_visited_at = ? WHERE id = ?"
      ).bind(now, id).run();
    },

    // Indexes (getIndexes support). When musicFolderId is provided, restrict to
    // artists that have at least one instance hosted by that source.
    async getArtistIndexes(musicFolderId?: string): Promise<Array<{ letter: string; artists: Artist[] }>> {
      const folder = musicFolderId;
      const filterBySource = folder && folder !== "default" && folder !== "0" && folder !== "";

      const sql = filterBySource
        ? `SELECT ar.* FROM artists ar
            WHERE EXISTS (
              SELECT 1 FROM song_masters sm
              JOIN song_instances si ON si.master_id = sm.id
              WHERE sm.artist_id = ar.id AND si.source_id = ?
            )
            ORDER BY ar.sort_name ASC NULLS LAST, ar.name ASC`
        : "SELECT * FROM artists ORDER BY sort_name ASC NULLS LAST, name ASC";

      const stmt = db.prepare(sql);
      const result = filterBySource
        ? await stmt.bind(folder).all<Artist>()
        : await stmt.all<Artist>();

      const groups: Record<string, Artist[]> = {};
      for (const artist of result.results) {
        const letter = (artist.sort_name || artist.name).charAt(0).toUpperCase();
        if (!groups[letter]) groups[letter] = [];
        groups[letter].push(artist);
      }
      return Object.entries(groups).map(([letter, artists]) => ({ letter, artists }));
    },

    // ========================================================================
    // ========================================================================
    async insertScanJob(opts: { id: string; sourceId: string }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO scan_jobs (id, source_id, status, total_items, scanned_items, started_at)
         VALUES (?, ?, 'running', 0, 0, ?)`
      ).bind(opts.id, opts.sourceId, now).run();
    },

    async updateScanJob(id: string, patch: {
      status?: "pending" | "running" | "completed" | "failed";
      totalItems?: number;
      scannedItems?: number;
      errorMessage?: string | null;
      endedAt?: number | null;
    }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status = ?"); binds.push(patch.status); }
      if (patch.totalItems !== undefined) { sets.push("total_items = ?"); binds.push(patch.totalItems); }
      if (patch.scannedItems !== undefined) { sets.push("scanned_items = ?"); binds.push(patch.scannedItems); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); binds.push(patch.errorMessage); }
      if (patch.endedAt !== undefined) { sets.push("ended_at = ?"); binds.push(patch.endedAt); }
      if (sets.length === 0) return;
      binds.push(id);
      await db.prepare(`UPDATE scan_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    },

    // ========================================================================
    // ========================================================================
    // The dispatcher (endpoints/transcode.ts) owns the row lifecycle:
    //  insertTranscodeJob → row in 'pending' / 'processing'
    //  updateTranscodeJob → status / output / error after engine returns
    // Engines themselves never touch D1; this keeps the abstraction simple.

    async insertTranscodeJob(opts: {
      id: string;
      instanceId: string;
      profile: string;            // legacy column — same value as profileId
      profileId: string;
      engine: string;
      status?: "pending" | "processing";
    }): Promise<void> {
      const status = opts.status ?? "pending";
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO transcode_jobs (id, instance_id, profile, profile_id, engine, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(opts.id, opts.instanceId, opts.profile, opts.profileId, opts.engine, status, now).run();
    },

    async updateTranscodeJob(id: string, patch: {
      status?: "pending" | "processing" | "completed" | "failed";
      outputInstanceId?: string | null;
      errorMessage?: string | null;
      completedAt?: number | null;
    }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status = ?"); binds.push(patch.status); }
      if (patch.outputInstanceId !== undefined) { sets.push("output_instance_id = ?"); binds.push(patch.outputInstanceId); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); binds.push(patch.errorMessage); }
      if (patch.completedAt !== undefined) { sets.push("completed_at = ?"); binds.push(patch.completedAt); }
      if (sets.length === 0) return;
      binds.push(id);
      await db.prepare(`UPDATE transcode_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    },

    async getTranscodeJob(id: string): Promise<TranscodeJob | null> {
      return db.prepare(
        "SELECT * FROM transcode_jobs WHERE id = ?"
      ).bind(id).first<TranscodeJob>();
    },

    // ========================================================================
    // ========================================================================
    // After the browser-pool worker (053) uploads a transcoded blob to R2,
    // we persist a song_instances row so the stream endpoint can short-circuit
    // future identical requests without queueing another transcode.
    //
  // - `id` is caller-provided (we use `si-bp-<random16>` from work_upload.ts
    //  so it's easy to grep / distinguish from upload-flow instances).
    // - `source_id` is fixed to 'r2-local' to match 049's transcode_jobs path
    //  (the output always lives in MUSIC_BUCKET).
    // - `parent_instance_id` is the original instance that triggered the
    //  transcode; tracking it lets the future tidy-up job cascade cleanly.
    // - `bit_rate` carries the profile bitrate (lossless flac is profile=0 →
    //  row gets 0 too; downstream already tolerates it).
    // - sample_rate / bit_depth / channels / duration are left NULL: ffmpeg.wasm
    //  doesn't probe its own output today. A future task may UPSERT these
    //  after the browser sends a metadata follow-up.
    //
  // Returns the inserted row id on success; null when the FK constraint
    // would fail (master_id missing → original instance was deleted between
    // enqueue and upload). The caller treats null as "no DB row, but R2 still
    // holds the bytes" and emits the upload ack as a partial success.
    async registerTranscodedInstance(opts: {
      id: string;
      masterId: string;
      parentInstanceId: string | null;
      storageUri: string;
      transcodeProfile: string;
      suffix: string;
      contentType: string;
      bitRate: number;
      size: number;
    }): Promise<string | null> {
      const now = Math.floor(Date.now() / 1000);
      try {
        await db.prepare(
          `INSERT INTO song_instances
             (id, master_id, source_id, source_type, parent_instance_id,
              storage_uri, transcode_profile, suffix, content_type,
              bit_rate, size, created_at, updated_at)
           VALUES (?, ?, 'r2-local', 'transcoded', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          opts.id,
          opts.masterId,
          opts.parentInstanceId,
          opts.storageUri,
          opts.transcodeProfile,
          opts.suffix,
          opts.contentType,
          opts.bitRate,
          opts.size,
          now,
          now,
        ).run();
        return opts.id;
      } catch {
        // FK violation (master gone) or PK conflict (idempotent re-upload).
        // Either way the byte payload in R2 is still valid; we just can't
        // index it. Return null to let the caller log + ack 200.
        return null;
      }
    },

    // Used by /rest/stream to short-circuit the 049 engine dispatch when the
    // browser pool (or pre-bake) has already produced the requested profile.
    async findTranscodedInstance(
      masterId: string,
      transcodeProfile: string,
    ): Promise<SongInstance | null> {
      return db.prepare(
        `SELECT * FROM song_instances
           WHERE master_id = ?
             AND source_type = 'transcoded'
             AND transcode_profile = ?
             AND missing = 0
         ORDER BY created_at DESC
         LIMIT 1`
      ).bind(masterId, transcodeProfile).first<SongInstance>();
    },

    // Latest scan_job per source (one row each, newest first by source).
    async getLatestScanJobs(): Promise<Array<{
      id: string;
      source_id: string;
      status: string;
      total_items: number;
      scanned_items: number;
      error_message: string | null;
      started_at: number;
      ended_at: number | null;
    }>> {
      const result = await db.prepare(
        `SELECT sj.* FROM scan_jobs sj
         WHERE sj.started_at = (
           SELECT MAX(started_at) FROM scan_jobs WHERE source_id = sj.source_id
         )
         ORDER BY sj.started_at DESC`
      ).all<{
        id: string;
        source_id: string;
        status: string;
        total_items: number;
        scanned_items: number;
        error_message: string | null;
        started_at: number;
        ended_at: number | null;
      }>();
      return result.results;
    },

    // ========================================================================
    // ========================================================================
    async listRadioStations(): Promise<InternetRadioStation[]> {
      const result = await db.prepare(
        "SELECT * FROM internet_radio_stations ORDER BY name ASC"
      ).all<InternetRadioStation>();
      return result.results;
    },

    async getRadioStation(id: string): Promise<InternetRadioStation | null> {
      return db.prepare("SELECT * FROM internet_radio_stations WHERE id = ?")
        .bind(id)
        .first<InternetRadioStation>();
    },

    async createRadioStation(opts: {
      id: string;
      name: string;
      streamUrl: string;
      homepageUrl?: string | null;
      createdBy?: string | null;
    }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO internet_radio_stations
         (id, name, stream_url, homepage_url, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        opts.id,
        opts.name,
        opts.streamUrl,
        opts.homepageUrl ?? null,
        opts.createdBy ?? null,
        now,
        now,
      ).run();
    },

    // Partial update. `homepageUrl === null` clears the column; `undefined` skips it.
    // Returns the number of rows changed (0 = not found).
    async updateRadioStation(
      id: string,
      patch: { name?: string; streamUrl?: string; homepageUrl?: string | null },
    ): Promise<number> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.name !== undefined) { sets.push("name = ?"); binds.push(patch.name); }
      if (patch.streamUrl !== undefined) { sets.push("stream_url = ?"); binds.push(patch.streamUrl); }
      if (patch.homepageUrl !== undefined) {
        sets.push("homepage_url = ?");
        binds.push(patch.homepageUrl);
      }
      if (sets.length === 0) return 0;
      sets.push("updated_at = ?");
      binds.push(Math.floor(Date.now() / 1000), id);
      const result = await db.prepare(
        `UPDATE internet_radio_stations SET ${sets.join(", ")} WHERE id = ?`
      ).bind(...binds).run();
      return Number(result.meta?.changes ?? 0);
    },

    async deleteRadioStation(id: string): Promise<number> {
      const result = await db.prepare(
        "DELETE FROM internet_radio_stations WHERE id = ?"
      ).bind(id).run();
      return Number(result.meta?.changes ?? 0);
    },

    // ========================================================================
    // ========================================================================
    // RSS sync writes channel meta + UPSERTs episodes by (channel_id, guid).
    // Subsonic endpoints read these tables; downloadPodcastEpisode mutates
    // the episode row asynchronously (status: new → downloading → completed).

    async listPodcastChannels(): Promise<PodcastChannel[]> {
      const result = await db.prepare(
        "SELECT * FROM podcast_channels ORDER BY created_at DESC"
      ).all<PodcastChannel>();
      return result.results;
    },

    async getPodcastChannel(id: string): Promise<PodcastChannel | null> {
      return db.prepare("SELECT * FROM podcast_channels WHERE id = ?")
        .bind(id).first<PodcastChannel>();
    },

    async getPodcastChannelByUrl(url: string): Promise<PodcastChannel | null> {
      return db.prepare("SELECT * FROM podcast_channels WHERE url = ?")
        .bind(url).first<PodcastChannel>();
    },

    async insertPodcastChannel(opts: { id: string; url: string }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO podcast_channels (id, url, status, created_at)
         VALUES (?, ?, 'new', ?)`
      ).bind(opts.id, opts.url, now).run();
    },

    // Patch channel meta after RSS parse. `status` decides completed vs error;
    // error_message is cleared on success so a recovering feed flushes the
    // previous failure note.
    async updatePodcastChannel(id: string, patch: {
      title?: string | null;
      description?: string | null;
      imageUrl?: string | null;
      language?: string | null;
      status?: "new" | "completed" | "error";
      errorMessage?: string | null;
      lastRefreshedAt?: number | null;
    }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.title !== undefined) { sets.push("title = ?"); binds.push(patch.title); }
      if (patch.description !== undefined) { sets.push("description = ?"); binds.push(patch.description); }
      if (patch.imageUrl !== undefined) { sets.push("image_url = ?"); binds.push(patch.imageUrl); }
      if (patch.language !== undefined) { sets.push("language = ?"); binds.push(patch.language); }
      if (patch.status !== undefined) { sets.push("status = ?"); binds.push(patch.status); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); binds.push(patch.errorMessage); }
      if (patch.lastRefreshedAt !== undefined) {
        sets.push("last_refreshed_at = ?");
        binds.push(patch.lastRefreshedAt);
      }
      if (sets.length === 0) return;
      binds.push(id);
      await db.prepare(
        `UPDATE podcast_channels SET ${sets.join(", ")} WHERE id = ?`
      ).bind(...binds).run();
    },

    async deletePodcastChannel(id: string): Promise<number> {
      // FK ON DELETE CASCADE handles podcast_episodes.
      const result = await db.prepare(
        "DELETE FROM podcast_channels WHERE id = ?"
      ).bind(id).run();
      return Number(result.meta?.changes ?? 0);
    },

    async listPodcastEpisodes(channelId: string): Promise<PodcastEpisode[]> {
      const result = await db.prepare(
        `SELECT * FROM podcast_episodes WHERE channel_id = ?
         ORDER BY published_at DESC NULLS LAST, created_at DESC`
      ).bind(channelId).all<PodcastEpisode>();
      return result.results;
    },

    async getPodcastEpisode(id: string): Promise<PodcastEpisode | null> {
      return db.prepare("SELECT * FROM podcast_episodes WHERE id = ?")
        .bind(id).first<PodcastEpisode>();
    },

    // Newest episodes across every channel — used by getNewestPodcasts.
    // Defaults to 20 per Subsonic spec (count parameter overrides).
    async listNewestEpisodes(count: number): Promise<PodcastEpisode[]> {
      const result = await db.prepare(
        `SELECT * FROM podcast_episodes
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT ?`
      ).bind(count).all<PodcastEpisode>();
      return result.results;
    },

    // UPSERT by (channel_id, guid): existing row updates meta but preserves
    // status / downloaded_r2_key so an in-flight download isn't reset.
    async upsertPodcastEpisode(opts: {
      id: string;
      channelId: string;
      guid: string;
      title?: string | null;
      description?: string | null;
      audioUrl?: string | null;
      publishedAt?: number | null;
      duration?: number | null;
      size?: number | null;
      bitRate?: number | null;
    }): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        `INSERT INTO podcast_episodes
           (id, channel_id, guid, title, description, audio_url,
            published_at, duration, size, bit_rate, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
         ON CONFLICT(channel_id, guid) DO UPDATE SET
           title       = excluded.title,
           description = excluded.description,
           audio_url   = excluded.audio_url,
           published_at = excluded.published_at,
           duration    = excluded.duration,
           size        = excluded.size,
           bit_rate    = excluded.bit_rate`
      ).bind(
        opts.id,
        opts.channelId,
        opts.guid,
        opts.title ?? null,
        opts.description ?? null,
        opts.audioUrl ?? null,
        opts.publishedAt ?? null,
        opts.duration ?? null,
        opts.size ?? null,
        opts.bitRate ?? null,
        now,
      ).run();
    },

    // Used by downloadPodcastEpisode lifecycle. Status `downloading` only sets
    // status; `completed` updates downloaded_r2_key + clears error_message.
    async updatePodcastEpisodeStatus(id: string, patch: {
      status?: "new" | "downloading" | "completed" | "error";
      downloadedR2Key?: string | null;
      errorMessage?: string | null;
      size?: number | null;
    }): Promise<void> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status = ?"); binds.push(patch.status); }
      if (patch.downloadedR2Key !== undefined) {
        sets.push("downloaded_r2_key = ?");
        binds.push(patch.downloadedR2Key);
      }
      if (patch.errorMessage !== undefined) {
        sets.push("error_message = ?");
        binds.push(patch.errorMessage);
      }
      if (patch.size !== undefined) { sets.push("size = ?"); binds.push(patch.size); }
      if (sets.length === 0) return;
      binds.push(id);
      await db.prepare(
        `UPDATE podcast_episodes SET ${sets.join(", ")} WHERE id = ?`
      ).bind(...binds).run();
    },

    async deletePodcastEpisode(id: string): Promise<number> {
      const result = await db.prepare(
        "DELETE FROM podcast_episodes WHERE id = ?"
      ).bind(id).run();
      return Number(result.meta?.changes ?? 0);
    },
  };
}

// ============================================================================
// Playlist helpers
// ============================================================================
async function computePlaylistTotals(db: D1Database, songIds: string[]): Promise<{ count: number; duration: number }> {
  if (songIds.length === 0) return { count: 0, duration: 0 };
  // would otherwise crash here on createPlaylist / replacePlaylistSongs. We
  // dedupe by song id (the existing comment about COUNT(*) collapsing dupes
  // already reflects this) then chunk-sum.
  const uniq = Array.from(new Set(songIds));
  const BATCH = 80;
  let totalCount = 0;
  let totalDuration = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const row = await db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(duration), 0) AS duration
       FROM song_masters WHERE id IN (${placeholders})`
    ).bind(...batch).first<{ count: number; duration: number }>();
    totalCount += row?.count ?? 0;
    totalDuration += row?.duration ?? 0;
  }
  return {
    // Multi-occurrences of the same songId still count once in COUNT(*) per
    // batch; on empty rows we fall back to the dedup'd input length so the
    // playlists.song_count column never lies about what was inserted.
    count: totalCount || uniq.length,
    duration: totalDuration,
  };
}

async function recalcPlaylistStats(db: D1Database, playlistId: string, now: number): Promise<void> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(sm.duration), 0) AS duration
     FROM playlist_songs ps JOIN song_masters sm ON sm.id = ps.song_master_id
     WHERE ps.playlist_id = ?`
  ).bind(playlistId).first<{ count: number; duration: number }>();
  await db.prepare("UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?")
    .bind(row?.count ?? 0, row?.duration ?? 0, now, playlistId).run();
}
