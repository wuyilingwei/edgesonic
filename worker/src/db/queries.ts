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

import type { Artist, Album, SongMaster, SongInstance, Annotation, User, Playlist, Bookmark, PlayQueue, TranscodeJob } from "../types/entities";

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

    async getSongsByGenre(genre: string, count: number, offset: number): Promise<SongMaster[]> {
      const result = await db.prepare(
        "SELECT * FROM song_masters WHERE genre = ? ORDER BY sort_title ASC LIMIT ? OFFSET ?"
      ).bind(genre, count, offset).all<SongMaster>();
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

    // Fetch song_masters by an arbitrary id list (deduped, order preserved by caller).
    async getSongMastersByIds(ids: string[]): Promise<SongMaster[]> {
      if (ids.length === 0) return [];
      const uniq = Array.from(new Set(ids));
      const placeholders = uniq.map(() => "?").join(",");
      const result = await db.prepare(
        `SELECT * FROM song_masters WHERE id IN (${placeholders})`
      ).bind(...uniq).all<SongMaster>();
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

    // Search — empty query matches everything (Navidrome-compatible full listing)
    async search(query: string, opts: {
      artistCount?: number; artistOffset?: number;
      albumCount?: number; albumOffset?: number;
      songCount?: number; songOffset?: number;
    } = {}): Promise<{
      artists: Artist[];
      albums: Album[];
      songs: Array<SongMaster & { artist_name: string | null; album_name: string | null }>;
    }> {
      const like = `%${query}%`;
      const [artists, albums, songs] = await Promise.all([
        db.prepare(
          "SELECT * FROM artists WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.artistCount ?? 20, opts.artistOffset ?? 0).all<Artist>(),
        db.prepare(
          "SELECT * FROM albums WHERE name LIKE ? ORDER BY sort_name ASC LIMIT ? OFFSET ?"
        ).bind(like, opts.albumCount ?? 20, opts.albumOffset ?? 0).all<Album>(),
        db.prepare(
          `SELECT sm.*, ar.name AS artist_name, al.name AS album_name
           FROM song_masters sm
           LEFT JOIN artists ar ON ar.id = sm.artist_id
           LEFT JOIN albums al ON al.id = sm.album_id
           WHERE sm.title LIKE ? ORDER BY sm.sort_title ASC LIMIT ? OFFSET ?`
        ).bind(like, opts.songCount ?? 20, opts.songOffset ?? 0)
          .all<SongMaster & { artist_name: string | null; album_name: string | null }>(),
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

    async getStarredSongs(
      userId: string,
    ): Promise<Array<SongMaster & { artist_name: string | null; album_name: string | null }>> {
      const result = await db.prepare(
        `SELECT sm.*, ar.name AS artist_name, al.name AS album_name
         FROM song_masters sm
         JOIN annotations an ON an.item_id = sm.id AND an.item_type = 'song'
         LEFT JOIN artists ar ON ar.id = sm.artist_id
         LEFT JOIN albums al ON al.id = sm.album_id
         WHERE an.user_id = ? AND an.starred = 1
         ORDER BY an.starred_at DESC`
      ).bind(userId).all<SongMaster & { artist_name: string | null; album_name: string | null }>();
      return result.results;
    },

    // getRandomSongs — D1 ORDER BY RANDOM() with optional genre / year filter.
    // year filter joins albums.year (song_masters has no year column).
    async getRandomSongs(opts: {
      size: number;
      genre?: string;
      fromYear?: number;
      toYear?: number;
    }): Promise<Array<SongMaster & { artist_name: string | null; album_name: string | null }>> {
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
        `SELECT sm.*, ar.name AS artist_name, al.name AS album_name
         FROM song_masters sm
         LEFT JOIN artists ar ON ar.id = sm.artist_id
         LEFT JOIN albums al ON al.id = sm.album_id
         ${whereSql}
         ORDER BY RANDOM() LIMIT ?`
      ).bind(...binds).all<SongMaster & { artist_name: string | null; album_name: string | null }>();
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

    async getPlaylistSongs(playlistId: string): Promise<SongMaster[]> {
      const result = await db.prepare(
        `SELECT sm.* FROM playlist_songs ps
         JOIN song_masters sm ON sm.id = ps.song_master_id
         WHERE ps.playlist_id = ? ORDER BY ps.position ASC`
      ).bind(playlistId).all<SongMaster>();
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
    // 037 — Bookmarks
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
    // 037 — PlayQueue (one saved queue per user; last-write-wins)
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
    // 038 — Scan Jobs (background scan progress)
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
    // 049 — Transcode Jobs
    // ========================================================================
    // The dispatcher (endpoints/transcode.ts) owns the row lifecycle:
    //   insertTranscodeJob → row in 'pending' / 'processing'
    //   updateTranscodeJob → status / output / error after engine returns
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
  };
}

// ============================================================================
// Playlist helpers
// ============================================================================
async function computePlaylistTotals(db: D1Database, songIds: string[]): Promise<{ count: number; duration: number }> {
  if (songIds.length === 0) return { count: 0, duration: 0 };
  const placeholders = songIds.map(() => "?").join(",");
  const row = await db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(duration), 0) AS duration
     FROM song_masters WHERE id IN (${placeholders})`
  ).bind(...songIds).first<{ count: number; duration: number }>();
  return {
    count: row?.count ?? songIds.length,
    // Multi-occurrences of the same songId still count once in COUNT(*), so fall back.
    duration: row?.duration ?? 0,
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
