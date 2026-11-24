import { tasteRatingSchema, type MovieCard, type TasteRequest } from '@movie-recommender/shared';
import type { ZodType } from 'zod';
import { COOLDOWN_MS } from '../recommendationInput';
import { GuestProfileDB } from './db';
import {
  MAX_HISTORY_ROUNDS,
  MAX_TASTE_RATINGS,
  cooldownRecordSchema,
  historyEntryInputSchema,
  historyEntrySchema,
  profileMovieIdSchema,
  ratingRecordSchema,
  watchedRecordSchema,
  watchlistRecordSchema,
  type CooldownRecord,
  type HistoryEntry,
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

export interface RecordRoundInput {
  kind: HistoryEntry['kind'];
  source: HistoryEntry['source'];
  prompt: string;
  replacedMovieId: number | null;
  movies: readonly MovieCard[];
}

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
 * Every taste-relevant write bumps `version`; callers use it to invalidate
 * cached derived data such as the taste vector. Recommendation history is not
 * taste input, so history writes deliberately leave `version` untouched.
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

  /**
   * Every rated movie id, uncapped. `ratingsPayload()` is capped at the taste
   * endpoint's 500-rating limit, so it cannot stand in for exclusions: over
   * 500 ratings, older rated films would lose their rated-implies-seen
   * exclusion and could be recommended again.
   */
  async getRatedIds(): Promise<number[]> {
    return uniqueSortedIds((await this.getRatings()).map((record) => record.movieId));
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
   * Cooldowns suppress a film that was replaced for seven days. They are a
   * "not tonight" signal: never a dislike and never a rating.
   */
  async getActiveCooldownIds(): Promise<number[]> {
    const now = this.now();
    const records = parseValidRecords(await this.storage.readCooldowns(), cooldownRecordSchema);

    return uniqueSortedIds(
      records.filter((record) => record.expiresAt > now).map((record) => record.movieId),
    );
  }

  async setCooldown(movieId: number): Promise<CooldownRecord> {
    const record: CooldownRecord = {
      movieId: movieIdOrThrow(movieId),
      expiresAt: this.now() + COOLDOWN_MS,
    };

    await this.storage.writeCooldown(record);
    this.version += 1;

    return record;
  }

  async removeCooldown(movieId: number): Promise<void> {
    await this.storage.deleteCooldown(movieIdOrThrow(movieId));
    this.version += 1;
  }

  /**
   * Batch form used by "refresh all": every id is validated before anything is
   * written, one expiry is computed for the batch, the storage layer writes it
   * in a single operation and the version bumps once. A partial refresh cannot
   * leave some picks cooled and others not.
   */
  async setCooldowns(movieIds: readonly number[]): Promise<CooldownRecord[]> {
    const ids = uniqueSortedIds(movieIds.map((movieId) => movieIdOrThrow(movieId)));

    if (ids.length === 0) {
      return [];
    }

    const expiresAt = this.now() + COOLDOWN_MS;
    const records = ids.map((movieId) => ({ movieId, expiresAt }));

    await this.storage.writeCooldowns(records);
    this.version += 1;

    return records;
  }

  async cooldownsCount(): Promise<number> {
    return (await this.getActiveCooldownIds()).length;
  }

  async hasCooldowns(): Promise<boolean> {
    return (await this.cooldownsCount()) > 0;
  }

  /**
   * Records one completed round for the dashboard. The whole entry is
   * validated before anything reaches storage. History is not taste input, so
   * this does not bump `version`: only taste-relevant writes may invalidate
   * the taste cache.
   */
  async recordRound(input: RecordRoundInput): Promise<HistoryEntry> {
    const parsed = historyEntryInputSchema.safeParse({
      createdAt: this.now(),
      kind: input.kind,
      source: input.source,
      prompt: input.prompt,
      replacedMovieId: input.replacedMovieId,
      movies: input.movies.map((movie) => ({
        id: movie.id,
        title: movie.title,
        releaseYear: movie.releaseYear,
        posterPath: movie.posterPath,
      })),
    });

    if (!parsed.success) {
      throw new GuestProfileValidationError(
        parsed.error.issues[0]?.message ?? 'Invalid history entry.',
      );
    }

    const id = await this.storage.writeHistoryEntry(parsed.data);
    await this.trimHistory();

    return { id, ...parsed.data };
  }

  /** Newest first by insertion id, dropping rows that no longer validate. */
  async getHistory(limit = 50): Promise<HistoryEntry[]> {
    const records = parseValidRecords(await this.storage.readHistory(), historyEntrySchema);

    return records.sort((left, right) => right.id - left.id).slice(0, limit);
  }

  async clearHistory(): Promise<void> {
    await this.storage.clearHistory();
  }

  /**
   * Deletes every guest-owned row as one storage operation. Ratings are gone,
   * so the taste cache must invalidate exactly once.
   */
  async clearAll(): Promise<void> {
    await this.storage.clearAll();
    this.version += 1;
  }

  /** Deletes all but the newest MAX_HISTORY_ROUNDS valid entries. */
  private async trimHistory(): Promise<void> {
    const records = parseValidRecords(await this.storage.readHistory(), historyEntrySchema);
    const staleIds = records
      .sort((left, right) => right.id - left.id)
      .slice(MAX_HISTORY_ROUNDS)
      .map((record) => record.id);

    for (const id of staleIds) {
      await this.storage.deleteHistoryEntry(id);
    }
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
