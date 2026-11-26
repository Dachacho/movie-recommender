import type { Database } from '../../db/client.js';
import type { MoodGenreWeights } from './mood.js';
import { findColdStartPool, findNearestMovies } from './query.js';
import {
  MAX_RECOMMENDATIONS,
  orderPoolByQuality,
  QUALITY_TILT_WEIGHT,
  selectDiverse,
} from './select.js';
import {
  CANDIDATE_POOL_SIZE,
  MAX_QUERY_LIMIT,
  POOL_TILT_BUFFER_SIZE,
  type MovieCandidate,
  type RecommendationFilters,
  type ScoredCandidate,
} from './types.js';

export interface RecommendMoviesInput {
  tasteVector?: readonly number[] | null;
  filters?: RecommendationFilters;
  excludeIds?: readonly number[];
  candidateIds?: readonly number[];
  exploration?: number;
  mood?: MoodGenreWeights | null;
  /** Evaluation-only override; the HTTP route never sets it. */
  moodBoostWeight?: number;
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

interface PoolQueryOptions {
  embedding: readonly number[];
  filters?: RecommendationFilters;
  excludeIds?: readonly number[];
  candidateIds?: readonly number[];
}

/**
 * Fetches the top POOL_TILT_BUFFER_SIZE cosine candidates. A single query is
 * capped at MAX_QUERY_LIMIT rows, so each page excludes what earlier pages
 * returned; the concatenation is the same ordered top-buffer list a single
 * unrestricted query would produce.
 */
async function fetchPoolTiltBuffer(
  db: Database,
  options: PoolQueryOptions,
): Promise<ScoredCandidate[]> {
  const buffer: ScoredCandidate[] = [];
  const excluded = new Set<number>(options.excludeIds);

  while (buffer.length < POOL_TILT_BUFFER_SIZE) {
    const chunkLimit = Math.min(MAX_QUERY_LIMIT, POOL_TILT_BUFFER_SIZE - buffer.length);
    const chunk = await findNearestMovies(db, {
      embedding: options.embedding,
      ...(options.filters === undefined ? {} : { filters: options.filters }),
      ...(excluded.size === 0 ? {} : { excludeIds: [...excluded] }),
      ...(options.candidateIds === undefined ? {} : { candidateIds: options.candidateIds }),
      ...(buffer.length === 0 ? {} : { trustedExcludeOverflow: true }),
      limit: chunkLimit,
    });

    for (const candidate of chunk) {
      buffer.push(candidate);
      excluded.add(candidate.movieId);
    }

    if (chunk.length < chunkLimit) {
      break;
    }
  }

  return buffer;
}

export async function recommendMovies(
  db: Database,
  input: RecommendMoviesInput,
): Promise<RecommendationResult> {
  validateLimit(input.limit);

  const eligibility = {
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.excludeIds === undefined ? {} : { excludeIds: input.excludeIds }),
    ...(input.candidateIds === undefined ? {} : { candidateIds: input.candidateIds }),
  };

  if (input.tasteVector !== undefined && input.tasteVector !== null) {
    const exploration = input.exploration ?? 0;

    if (exploration === 0) {
      // The measured pool-stage tilt orders the wider cosine buffer, then keeps
      // the production pool; see docs/evaluation-experiments-2026-11-24-round2.md.
      const buffer = await fetchPoolTiltBuffer(db, {
        embedding: input.tasteVector,
        ...eligibility,
      });
      const pool = orderPoolByQuality(
        buffer,
        QUALITY_TILT_WEIGHT,
        input.mood ?? null,
        input.moodBoostWeight,
      ).slice(0, CANDIDATE_POOL_SIZE);

      return {
        movieIds: selectDiverse(pool, {
          limit: input.limit,
          mood: input.mood ?? null,
          ...(input.moodBoostWeight === undefined
            ? {}
            : { moodBoostWeight: input.moodBoostWeight }),
        }).map((pick) => pick.movieId),
        coldStart: false,
      };
    }

    // Exploration changes the pool's composition: part of it is drawn from a
    // deep similarity band so the rerank can pick genuinely outside-the-usual
    // films. It never widens or narrows eligibility. Cold start has no taste
    // similarity to explore away from, so the option does not apply there.
    const pool = await findNearestMovies(db, {
      embedding: input.tasteVector,
      ...eligibility,
      limit: CANDIDATE_POOL_SIZE,
      exploration,
    });

    return {
      movieIds: selectDiverse(pool, {
        limit: input.limit,
        mood: input.mood ?? null,
        ...(input.moodBoostWeight === undefined ? {} : { moodBoostWeight: input.moodBoostWeight }),
      }).map((pick) => pick.movieId),
      coldStart: false,
    };
  }

  const pool = await findColdStartPool(db, {
    ...eligibility,
    limit: CANDIDATE_POOL_SIZE,
  });

  return {
    movieIds: selectDiverse(rankAsRelevance(pool), {
      limit: input.limit,
      mood: input.mood ?? null,
      ...(input.moodBoostWeight === undefined ? {} : { moodBoostWeight: input.moodBoostWeight }),
    }).map((pick) => pick.movieId),
    coldStart: true,
  };
}
