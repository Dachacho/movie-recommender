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
