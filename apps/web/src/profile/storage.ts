import type { GuestProfileDB } from './db';
import type { RatingRecord, WatchedRecord, WatchlistRecord } from './schema';

/**
 * Narrow persistence boundary for the guest profile. Reads return `unknown`
 * rows so the facade validates whatever IndexedDB stored, including data
 * edited outside the app.
 */
export interface GuestProfileStorage {
  readRatings(): Promise<unknown[]>;
  writeRating(record: RatingRecord): Promise<void>;
  deleteRating(movieId: number): Promise<void>;
  readWatched(): Promise<unknown[]>;
  writeWatched(record: WatchedRecord): Promise<void>;
  deleteWatched(movieId: number): Promise<void>;
  readWatchlist(): Promise<unknown[]>;
  writeWatchlist(record: WatchlistRecord): Promise<void>;
  deleteWatchlist(movieId: number): Promise<void>;
}

export function createDexieStorage(db: GuestProfileDB): GuestProfileStorage {
  return {
    readRatings: () => db.ratings.toArray(),
    writeRating: async (record) => {
      await db.ratings.put(record);
    },
    deleteRating: (movieId) => db.ratings.delete(movieId),
    readWatched: () => db.watched.toArray(),
    writeWatched: async (record) => {
      await db.watched.put(record);
    },
    deleteWatched: (movieId) => db.watched.delete(movieId),
    readWatchlist: () => db.watchlist.toArray(),
    writeWatchlist: async (record) => {
      await db.watchlist.put(record);
    },
    deleteWatchlist: (movieId) => db.watchlist.delete(movieId),
  };
}
