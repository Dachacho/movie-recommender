import { tasteRatingSchema, type TasteRequest } from '@movie-recommender/shared';
import type { ZodType } from 'zod';
import { GuestProfileDB } from './db';
import {
  MAX_TASTE_RATINGS,
  profileMovieIdSchema,
  ratingRecordSchema,
  watchedRecordSchema,
  watchlistRecordSchema,
  type RatingRecord,
  type WatchedRecord,
  type WatchlistRecord,
} from './schema';
import { createDexieStorage, type GuestProfileStorage } from './storage';

export class GuestProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestProfileValidationError';
  }
}

export interface GuestProfileOptions {
  now?: () => number;
}

export type RatingsPayload = TasteRequest['ratings'];

function parseValidRecords<T>(rows: unknown[], schema: ZodType<T>): T[] {
  const records: T[] = [];

  for (const row of rows) {
    const parsed = schema.safeParse(row);

    if (parsed.success) {
      records.push(parsed.data);
    }
  }

  return records;
}

function movieIdOrThrow(movieId: number): number {
  const parsed = profileMovieIdSchema.safeParse(movieId);

  if (!parsed.success) {
    throw new GuestProfileValidationError(
      parsed.error.issues[0]?.message ?? 'movieId must be a positive integer.',
    );
  }

  return parsed.data;
}

function uniqueSortedIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Facade over guest-only IndexedDB data. Storage is injected so tests use an
 * in-memory implementation and the app uses Dexie.
 *
 * Every successful write bumps `version`; callers use it to invalidate cached
 * derived data such as the taste vector.
 */
export class GuestProfile {
  private readonly storage: GuestProfileStorage;
  private readonly now: () => number;
  private version = 0;

  constructor(storage: GuestProfileStorage, options: GuestProfileOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? Date.now;
  }

  getVersion(): number {
    return this.version;
  }

  async getRatings(): Promise<RatingRecord[]> {
    const records = parseValidRecords(await this.storage.readRatings(), ratingRecordSchema);

    return records.sort((left, right) => left.movieId - right.movieId);
  }

  async setRating(movieId: number, rating: number): Promise<RatingRecord> {
    const parsed = tasteRatingSchema.safeParse({ movieId, rating });

    if (!parsed.success) {
      throw new GuestProfileValidationError(parsed.error.issues[0]?.message ?? 'Invalid rating.');
    }

    const record: RatingRecord = { ...parsed.data, updatedAt: this.now() };
    await this.storage.writeRating(record);
    this.version += 1;

    return record;
  }

  async removeRating(movieId: number): Promise<void> {
    await this.storage.deleteRating(movieIdOrThrow(movieId));
    this.version += 1;
  }

  async getWatchedIds(): Promise<number[]> {
    const records = parseValidRecords(await this.storage.readWatched(), watchedRecordSchema);

    return uniqueSortedIds(records.map((record) => record.movieId));
  }

  async setWatched(movieId: number): Promise<WatchedRecord> {
    const record: WatchedRecord = { movieId: movieIdOrThrow(movieId), watchedAt: this.now() };
    await this.storage.writeWatched(record);
    this.version += 1;

    return record;
  }

  async removeWatched(movieId: number): Promise<void> {
    await this.storage.deleteWatched(movieIdOrThrow(movieId));
    this.version += 1;
  }

  async getWatchlistIds(): Promise<number[]> {
    const records = parseValidRecords(await this.storage.readWatchlist(), watchlistRecordSchema);

    return uniqueSortedIds(records.map((record) => record.movieId));
  }

  async addToWatchlist(movieId: number): Promise<WatchlistRecord> {
    const record: WatchlistRecord = { movieId: movieIdOrThrow(movieId), addedAt: this.now() };
    await this.storage.writeWatchlist(record);
    this.version += 1;

    return record;
  }

  async removeFromWatchlist(movieId: number): Promise<void> {
    await this.storage.deleteWatchlist(movieIdOrThrow(movieId));
    this.version += 1;
  }

  /**
   * Shaped for `tasteRequestSchema`: unique ids sorted by movieId, capped at
   * the endpoint's 500-rating limit. When there are more, the most recently
   * updated ratings win (ties broken by movieId) so recent taste changes are
   * the ones that reach the API.
   */
  async ratingsPayload(): Promise<RatingsPayload> {
    const latestById = new Map<number, RatingRecord>();

    for (const record of await this.getRatings()) {
      const existing = latestById.get(record.movieId);

      if (existing === undefined || record.updatedAt > existing.updatedAt) {
        latestById.set(record.movieId, record);
      }
    }

    return [...latestById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.movieId - right.movieId)
      .slice(0, MAX_TASTE_RATINGS)
      .sort((left, right) => left.movieId - right.movieId)
      .map(({ movieId, rating }) => ({ movieId, rating }));
  }

  async ratingsCount(): Promise<number> {
    return new Set((await this.getRatings()).map((record) => record.movieId)).size;
  }

  async hasRatings(): Promise<boolean> {
    return (await this.ratingsCount()) > 0;
  }
}

export function createGuestProfile(): GuestProfile {
  return new GuestProfile(createDexieStorage(new GuestProfileDB()));
}
