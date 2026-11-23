export const EXPECTED_EMBEDDING_DIMENSIONS = 384;
export const MAX_QUERY_LIMIT = 200;
export const MAX_ID_COUNT = 10_000;

/** Taste-selected candidates handed to the diversity rerank in production. */
export const CANDIDATE_POOL_SIZE = 50;

/**
 * Rank where the exploration deep band starts, ten production pools beyond the
 * near band. Exploration fills part of the pool from ranks here instead of the
 * top, so "Surprise me" widens the candidate pool rather than reweighting it.
 */
export const DEEP_BAND_START = 10 * CANDIDATE_POOL_SIZE;

export interface RecommendationFilters {
  runtimeMin?: number;
  runtimeMax?: number;
  yearMin?: number;
  yearMax?: number;
  genres?: string[];
}

export interface MovieCandidate {
  movieId: number;
  embedding: number[];
  voteAverage: number | null;
  voteCount: number | null;
}

export interface ScoredCandidate extends MovieCandidate {
  similarity: number;
}
