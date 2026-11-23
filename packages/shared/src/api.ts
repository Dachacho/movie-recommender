import { z } from 'zod';

export const movieCardSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  runtime: z.number().int().nullable(),
  overview: z.string().nullable(),
  genres: z.array(z.string()),
  director: z.string().nullable(),
  cast: z.array(z.string()),
  posterPath: z.string().nullable(),
  voteAverage: z.number().nullable(),
});
export type MovieCard = z.infer<typeof movieCardSchema>;

export const movieSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
});
export type MovieSearchQuery = z.infer<typeof movieSearchQuerySchema>;

export const movieListResponseSchema = z.object({ movies: z.array(movieCardSchema) });
export type MovieListResponse = z.infer<typeof movieListResponseSchema>;

export const movieDetailResponseSchema = z.object({ movie: movieCardSchema });
export type MovieDetailResponse = z.infer<typeof movieDetailResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const tasteRatingSchema = z.object({
  movieId: z.number().int().positive().max(2_147_483_647),
  rating: z
    .number()
    .refine((value) => Number.isFinite(value), 'rating must be finite')
    .min(0.5)
    .max(5)
    .refine((value) => Number.isInteger(value * 2), 'rating must be a half-star value'),
});
export const tasteRequestSchema = z.object({
  ratings: z
    .array(tasteRatingSchema)
    .min(1)
    .max(500)
    .refine(
      (ratings) => new Set(ratings.map((entry) => entry.movieId)).size === ratings.length,
      'movieId values must be unique',
    ),
});
export type TasteRequest = z.infer<typeof tasteRequestSchema>;

export const tasteResponseSchema = z.object({
  tasteVector: z.array(z.number()).length(384).nullable(),
});
export type TasteResponse = z.infer<typeof tasteResponseSchema>;

export const RECOMMENDATION_SOURCES = ['catalog', 'watchlist', 'list'] as const;
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];

export const recommendationSourceSchema = z.enum(RECOMMENDATION_SOURCES);

const movieIdsSchema = z
  .array(z.number().int().positive().max(2_147_483_647))
  .max(10_000)
  .refine((ids) => new Set(ids).size === ids.length, 'movie ids must be unique');

export const tasteVectorSchema = z
  .array(
    z
      .number()
      .refine((value) => Number.isFinite(value), 'taste vector values must be finite')
      .refine(
        (value) => Math.abs(value) <= 10,
        'taste vector values must be at most 10 in magnitude',
      ),
  )
  .length(384);

export const recommendationRequestSchema = z
  .object({
    source: recommendationSourceSchema,
    prompt: z.string().trim().min(1).max(300).nullish(),
    tasteVector: tasteVectorSchema.nullish(),
    candidateIds: movieIdsSchema.optional(),
    excludeIds: movieIdsSchema.optional(),
    limit: z.number().int().min(1).max(4),
    exploration: z.number().min(0).max(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === 'catalog') {
      if (value.candidateIds !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['candidateIds'],
          message: 'candidateIds must be omitted when source is catalog.',
        });
      }

      return;
    }

    if (value.candidateIds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidateIds'],
        message: 'candidateIds is required when source is watchlist or list.',
      });
    } else if (value.candidateIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidateIds'],
        message: 'candidateIds must not be empty when source is watchlist or list.',
      });
    }
  });
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

export const recommendationResponseSchema = z.object({
  movies: z.array(movieCardSchema),
  coldStart: z.boolean(),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

export const LETTERBOXD_MAX_CSV_LENGTH = 200_000;

export const letterboxdImportRequestSchema = z.object({
  csv: z.string().min(1).max(LETTERBOXD_MAX_CSV_LENGTH),
});
export type LetterboxdImportRequest = z.infer<typeof letterboxdImportRequestSchema>;

export const LETTERBOXD_UNMATCHED_REASONS = ['no_match'] as const;

export const letterboxdUnmatchedReasonSchema = z.enum(LETTERBOXD_UNMATCHED_REASONS);
export type LetterboxdUnmatchedReason = z.infer<typeof letterboxdUnmatchedReasonSchema>;

export const letterboxdMatchedSchema = z.object({
  movieId: z.number().int().positive(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  // Null means the row carried no rating: either a watches export (watched)
  // or a watchlist export (added to the watchlist) — the client routes by file mode.
  rating: z
    .number()
    .min(0.5)
    .max(5)
    .refine((value) => Number.isInteger(value * 2), 'rating must be a half-star value')
    .nullable(),
});
export type LetterboxdMatched = z.infer<typeof letterboxdMatchedSchema>;

export const letterboxdUnmatchedSchema = z.object({
  name: z.string(),
  year: z.number().int().nullable(),
  reason: letterboxdUnmatchedReasonSchema,
});
export type LetterboxdUnmatched = z.infer<typeof letterboxdUnmatchedSchema>;

export const letterboxdImportStatsSchema = z.object({
  rows: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
});
export type LetterboxdImportStats = z.infer<typeof letterboxdImportStatsSchema>;

export const letterboxdImportResponseSchema = z.object({
  matched: z.array(letterboxdMatchedSchema),
  unmatched: z.array(letterboxdUnmatchedSchema),
  stats: letterboxdImportStatsSchema,
});
export type LetterboxdImportResponse = z.infer<typeof letterboxdImportResponseSchema>;
