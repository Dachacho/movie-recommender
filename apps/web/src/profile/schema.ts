import { tasteRatingSchema } from '@movie-recommender/shared';
import { z } from 'zod';
import { RECOMMENDATION_SOURCE_KINDS } from '../recommendationInput';

const timestampSchema = z.number().int().nonnegative();

export const ratingRecordSchema = tasteRatingSchema.extend({
  updatedAt: timestampSchema,
});
export type RatingRecord = z.infer<typeof ratingRecordSchema>;

export const watchedRecordSchema = z.object({
  movieId: tasteRatingSchema.shape.movieId,
  watchedAt: timestampSchema,
});
export type WatchedRecord = z.infer<typeof watchedRecordSchema>;

export const watchlistRecordSchema = z.object({
  movieId: tasteRatingSchema.shape.movieId,
  addedAt: timestampSchema,
});
export type WatchlistRecord = z.infer<typeof watchlistRecordSchema>;

export const cooldownRecordSchema = z.object({
  movieId: tasteRatingSchema.shape.movieId,
  expiresAt: timestampSchema,
});
export type CooldownRecord = z.infer<typeof cooldownRecordSchema>;

export const profileMovieIdSchema = tasteRatingSchema.shape.movieId;

/**
 * The part of a recommendation pick the dashboard needs to render a round
 * without fetching the catalog again.
 */
export const historyMovieSnapshotSchema = z.object({
  id: profileMovieIdSchema,
  title: z.string().trim().min(1).max(500),
  /** Mirrors the API's hard-filter release-year bounds. */
  releaseYear: z.number().int().min(1870).max(2100).nullable(),
  posterPath: z.string().min(1).nullable(),
});
export type HistoryMovieSnapshot = z.infer<typeof historyMovieSnapshotSchema>;

export const historyEntrySchema = z.object({
  /** Assigned by the storage's auto-increment key. */
  id: z.number().int().positive(),
  createdAt: timestampSchema,
  kind: z.enum(['round', 'replace', 'refresh']),
  source: z.enum(RECOMMENDATION_SOURCE_KINDS),
  prompt: z.string().max(300),
  replacedMovieId: profileMovieIdSchema.nullable(),
  movies: z.array(historyMovieSnapshotSchema).min(1).max(4),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyEntryInputSchema = historyEntrySchema.omit({ id: true });
export type HistoryEntryInput = z.infer<typeof historyEntryInputSchema>;

/** The taste endpoint accepts at most 500 ratings per request. */
export const MAX_TASTE_RATINGS = 500;

/** Oldest rounds are deleted once more than this many are stored. */
export const MAX_HISTORY_ROUNDS = 100;
