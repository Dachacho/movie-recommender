export const EXPECTED_EMBEDDING_DIMENSIONS = 384;
export const MAX_QUERY_LIMIT = 200;
export const MAX_ID_COUNT = 10_000;

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
