export const EXPECTED_EMBEDDING_DIMENSIONS = 384;
export const MAX_QUERY_LIMIT = 200;
export const MAX_ID_COUNT = 10_000;

/** Taste-selected candidates handed to the diversity rerank in production. */
export const CANDIDATE_POOL_SIZE = 50;

/**
 * Measured retrieval depth for the pool-stage quality tilt: the top-500 cosine
 * buffer is reordered by the 0.50 tilt and the first CANDIDATE_POOL_SIZE become
 * the production pool. Chosen on the held-out evidence in
 * docs/evaluation-experiments-2026-11-24-round2.md (pool 50 — tilt at pool +
 * rerank lifts Recall@4 0.0064 to 0.0078, NDCG@4 0.0156 to 0.0195 and MRR
 * 0.0385 to 0.0570).
 */
export const POOL_TILT_BUFFER_SIZE = 500;

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
  genres?: readonly string[] | null;
}

export interface ScoredCandidate extends MovieCandidate {
  similarity: number;
}
