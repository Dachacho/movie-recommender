import { tasteRatingSchema } from '@movie-recommender/shared';
import { z } from 'zod';

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

/** The taste endpoint accepts at most 500 ratings per request. */
export const MAX_TASTE_RATINGS = 500;
