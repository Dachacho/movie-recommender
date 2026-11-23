import type { Database } from '../../db/client.js';
import { findColdStartPool, findNearestMovies } from './query.js';
import { MAX_RECOMMENDATIONS, applyExploration, selectDiverse } from './select.js';
import type { MovieCandidate, RecommendationFilters, ScoredCandidate } from './types.js';

export const CANDIDATE_POOL_SIZE = 50;

export interface RecommendMoviesInput {
  tasteVector?: readonly number[] | null;
  filters?: RecommendationFilters;
  excludeIds?: readonly number[];
  candidateIds?: readonly number[];
  exploration?: number;
  limit: number;
}

export interface RecommendationResult {
  movieIds: number[];
  coldStart: boolean;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOMMENDATIONS) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_RECOMMENDATIONS}, received ${limit}.`,
    );
  }
}

function rankAsRelevance(pool: readonly MovieCandidate[]): ScoredCandidate[] {
  // Cold start has no query vector, so pool rank stands in for relevance.
  // selectDiverse still adds the quality tilt: with no taste signal there is
  // nothing to protect, so a well-received film may move up to about 25 pool
  // ranks at the extreme (0.50 tilt against 0.02 rank spacing); wider gaps keep
  // pool order dominant. Pool order (md5 of the id) and vote fields are
  // deterministic, so the outcome is stable.
  return pool.map((candidate, index) => ({
    ...candidate,
    similarity: 1 - index / pool.length,
  }));
}

export async function recommendMovies(
  db: Database,
  input: RecommendMoviesInput,
): Promise<RecommendationResult> {
  validateLimit(input.limit);

  const shared = {
    limit: CANDIDATE_POOL_SIZE,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.excludeIds === undefined ? {} : { excludeIds: input.excludeIds }),
    ...(input.candidateIds === undefined ? {} : { candidateIds: input.candidateIds }),
  };

  if (input.tasteVector !== undefined && input.tasteVector !== null) {
    const pool = await findNearestMovies(db, { embedding: input.tasteVector, ...shared });
    // Exploration relaxes taste ranking inside the already-filtered pool; it
    // never widens or narrows eligibility. Cold start has no taste similarity
    // to relax, so the option does not apply there.
    const relaxed = applyExploration(pool, input.exploration ?? 0);

    return {
      movieIds: selectDiverse(relaxed, { limit: input.limit }).map((pick) => pick.movieId),
      coldStart: false,
    };
  }

  const pool = await findColdStartPool(db, shared);

  return {
    movieIds: selectDiverse(rankAsRelevance(pool), { limit: input.limit }).map(
      (pick) => pick.movieId,
    ),
    coldStart: true,
  };
}
