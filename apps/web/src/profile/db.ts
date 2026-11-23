import Dexie, { type Table } from 'dexie';
import type { CooldownRecord, RatingRecord, WatchedRecord, WatchlistRecord } from './schema';

const DEFAULT_GUEST_PROFILE_DB_NAME = 'movie-recommender-guest-profile';

/**
 * IndexedDB database for guest-only data. It is only ever opened in the
 * browser; tests inject an in-memory GuestProfileStorage instead.
 */
export class GuestProfileDB extends Dexie {
  ratings!: Table<RatingRecord, number>;
  watched!: Table<WatchedRecord, number>;
  watchlist!: Table<WatchlistRecord, number>;
  cooldowns!: Table<CooldownRecord, number>;

  constructor(name: string = DEFAULT_GUEST_PROFILE_DB_NAME) {
    super(name);
    this.version(1).stores({
      ratings: 'movieId, updatedAt',
      watched: 'movieId, watchedAt',
      watchlist: 'movieId, addedAt',
    });
    // Version 2 adds cooldowns. Dexie keeps the existing tables across
    // versions; they are re-declared here so the schema stays readable.
    this.version(2).stores({
      ratings: 'movieId, updatedAt',
      watched: 'movieId, watchedAt',
      watchlist: 'movieId, addedAt',
      cooldowns: 'movieId, expiresAt',
    });
  }
}
