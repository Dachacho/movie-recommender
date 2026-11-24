import type { Database } from '../db/client.js';
import { findNearestMovies } from '../modules/recommendations/query.js';
import {
  DEFAULT_DIVERSITY_PENALTY,
  MAX_RECOMMENDATIONS,
  orderPoolByQuality,
  qualityScore,
  selectDiverse,
} from '../modules/recommendations/select.js';
import { MAX_QUERY_LIMIT, type ScoredCandidate } from '../modules/recommendations/types.js';
import type { CatalogEntry } from './load.js';

/** Retrieval depth for the taste ranking and both baselines. */
export const EVALUATION_CANDIDATES = 100;

/** Genres taken from a user's train likes to build the genre baseline profile. */
export const GENRE_PROFILE_SIZE = 3;

/**
 * Deepest pool the experiments retrieve. It is also the cosine buffer that the
 * pool-stage tilt sorts before slicing, so a high-quality film just outside the
 * delivered pool can still enter it.
 */
export const EVALUATION_MAX_POOL = 500;

export interface UserRanking {
  showcase: number[];
  popularity: number[];
  genre: number[];
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${value}.`);
  }
}

function validateWeight(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a finite number greater than or equal to 0, received ${value}.`,
    );
  }
}

function validatePenalty(penalty: number): void {
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 1) {
    throw new RangeError(`penalty must be a finite number between 0 and 1, received ${penalty}.`);
  }
}

function validateBlendWeight(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1, received ${value}.`);
  }
}

function validateLimit(limit: number): void {
  validatePositiveInteger(limit, 'limit');
}

/**
 * The user's strongest genres from train likes: count each genre across the
 * liked films, then rank by count and break ties alphabetically. An empty
 * profile means no genre signal, which leaves the genre baseline at id order.
 */
export function topLikedGenres(
  liked: readonly CatalogEntry[],
  limit: number = GENRE_PROFILE_SIZE,
): string[] {
  validateLimit(limit);

  const counts = new Map<string, number>();

  for (const movie of liked) {
    for (const genre of movie.genres) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(([leftGenre, leftCount], [rightGenre, rightCount]) => {
      if (leftCount !== rightCount) {
        return rightCount - leftCount;
      }

      return leftGenre < rightGenre ? -1 : leftGenre > rightGenre ? 1 : 0;
    })
    .slice(0, limit)
    .map(([genre]) => genre);
}

/** Popularity baseline: vote count descending, films without votes last, id ascending. */
export function rankByPopularity(universe: readonly CatalogEntry[], limit: number): number[] {
  validateLimit(limit);

  return [...universe]
    .sort((left, right) => {
      if (left.voteCount === null && right.voteCount === null) {
        return left.movieId - right.movieId;
      }

      if (left.voteCount === null) {
        return 1;
      }

      if (right.voteCount === null) {
        return -1;
      }

      if (left.voteCount !== right.voteCount) {
        return right.voteCount - left.voteCount;
      }

      return left.movieId - right.movieId;
    })
    .slice(0, limit)
    .map((entry) => entry.movieId);
}

/** Genre baseline: most shared genres with the profile, then id ascending. */
export function rankByGenre(
  universe: readonly CatalogEntry[],
  genres: readonly string[],
  limit: number,
): number[] {
  validateLimit(limit);

  const wanted = new Set(genres);

  return universe
    .map((entry) => {
      let shared = 0;

      for (const genre of entry.genres) {
        if (wanted.has(genre)) {
          shared += 1;
        }
      }

      return { movieId: entry.movieId, shared };
    })
    .sort((left, right) =>
      left.shared !== right.shared ? right.shared - left.shared : left.movieId - right.movieId,
    )
    .slice(0, limit)
    .map((entry) => entry.movieId);
}

/**
 * Ranks one user against the catalog. The showcase path mirrors production:
 * findNearestMovies supplies the taste pool, exploration stays at 0, and
 * selectDiverse applies the same quality tilt, diversity penalty and limit the
 * API serves. Both baselines rank the same eligible universe minus every film
 * the user rated in train; held-out test films stay eligible, otherwise no
 * relevant item could ever be retrieved.
 */
export async function rankUser(
  db: Database,
  input: {
    embedding: readonly number[];
    excludedIds: readonly number[];
    universe: readonly CatalogEntry[];
    likedGenres: readonly string[];
  },
): Promise<UserRanking> {
  const pool = await findNearestMovies(db, {
    embedding: input.embedding,
    excludeIds: input.excludedIds,
    limit: EVALUATION_CANDIDATES,
  });
  const showcase = selectDiverse(pool, { limit: MAX_RECOMMENDATIONS }).map((pick) => pick.movieId);
  const excluded = new Set(input.excludedIds);
  const eligible = input.universe.filter((entry) => !excluded.has(entry.movieId));

  return {
    showcase,
    popularity: rankByPopularity(eligible, EVALUATION_CANDIDATES),
    genre: rankByGenre(eligible, input.likedGenres, EVALUATION_CANDIDATES),
  };
}

/**
 * Retrieves the cosine pool in pages, because `findNearestMovies` rejects a
 * limit above `MAX_QUERY_LIMIT`. Each page excludes the ids already returned,
 * so the concatenated result is the same ordered top-`size` list a single
 * unrestricted query would produce: distance ascending, then movie id.
 */
export async function fetchNearestPool(
  db: Database,
  input: {
    embedding: readonly number[];
    excludeIds: readonly number[];
    size: number;
  },
): Promise<ScoredCandidate[]> {
  validatePositiveInteger(input.size, 'size');

  if (input.size > EVALUATION_MAX_POOL) {
    throw new RangeError(`size must not exceed ${EVALUATION_MAX_POOL}, received ${input.size}.`);
  }

  const pool: ScoredCandidate[] = [];
  const excluded = new Set(input.excludeIds);

  while (pool.length < input.size) {
    const chunkLimit = Math.min(MAX_QUERY_LIMIT, input.size - pool.length);
    const chunk = await findNearestMovies(db, {
      embedding: input.embedding,
      excludeIds: [...excluded],
      limit: chunkLimit,
    });

    for (const candidate of chunk) {
      pool.push(candidate);
      excluded.add(candidate.movieId);
    }

    if (chunk.length < chunkLimit) {
      break;
    }
  }

  return pool;
}

interface PreparedCandidate {
  movieId: number;
  similarity: number;
  quality: number;
  voteCount: number | null;
  scaled: Float64Array;
  normSquared: number;
}

function maxAbsoluteComponent(values: readonly number[]): number {
  let max = 0;

  for (const value of values) {
    const absolute = Math.abs(value);

    if (absolute > max) {
      max = absolute;
    }
  }

  return max;
}

/**
 * Pre-scales each embedding the same way `selectDiverse` does per comparison, so
 * the greedy loop can reuse it without changing a single floating-point result.
 */
function prepareCandidates(candidates: readonly ScoredCandidate[]): PreparedCandidate[] {
  return candidates.map((candidate) => {
    const max = maxAbsoluteComponent(candidate.embedding);
    const scaled = new Float64Array(candidate.embedding.length);
    let normSquared = 0;

    if (max > 0) {
      for (let index = 0; index < candidate.embedding.length; index += 1) {
        const value = (candidate.embedding[index] ?? 0) / max;

        scaled[index] = value;
        normSquared += value * value;
      }
    }

    return {
      movieId: candidate.movieId,
      similarity: candidate.similarity,
      quality: qualityScore(candidate.voteAverage, candidate.voteCount),
      voteCount: candidate.voteCount,
      scaled,
      normSquared,
    };
  });
}

function preparedCosine(left: PreparedCandidate, right: PreparedCandidate): number {
  if (left.normSquared === 0 || right.normSquared === 0) {
    return 0;
  }

  let dotProduct = 0;

  for (let index = 0; index < left.scaled.length; index += 1) {
    dotProduct += (left.scaled[index] ?? 0) * (right.scaled[index] ?? 0);
  }

  return dotProduct / (Math.sqrt(left.normSquared) * Math.sqrt(right.normSquared));
}

export type RerankScoring =
  | { mode: 'tilt' }
  | { mode: 'zscore'; weight: number }
  | { mode: 'fusion'; weight: number; k?: number };

const FUSION_DEFAULT_K = 60;

function validateScoring(scoring: RerankScoring): void {
  if (scoring.mode === 'tilt') {
    return;
  }

  validateBlendWeight(scoring.weight, 'scoring weight');

  if (scoring.mode === 'fusion') {
    validatePositiveInteger(scoring.k ?? FUSION_DEFAULT_K, 'k');
  }
}

function standardise(values: readonly number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  let sum = 0;

  for (const value of values) {
    sum += value;
  }

  const mean = sum / values.length;
  let squaredDeviations = 0;

  for (const value of values) {
    const deviation = value - mean;

    squaredDeviations += deviation * deviation;
  }

  const standardDeviation = Math.sqrt(squaredDeviations / values.length);

  if (standardDeviation === 0) {
    return values.map(() => 0);
  }

  return values.map((value) => (value - mean) / standardDeviation);
}

function zscoreBaseScores(prepared: readonly PreparedCandidate[], weight: number): number[] {
  const similarities = standardise(prepared.map((candidate) => candidate.similarity));
  const qualities = standardise(prepared.map((candidate) => candidate.quality));

  return prepared.map(
    (_, index) => (1 - weight) * (similarities[index] ?? 0) + weight * (qualities[index] ?? 0),
  );
}

function compareSimilarity(left: PreparedCandidate, right: PreparedCandidate): number {
  if (left.similarity !== right.similarity) {
    return right.similarity - left.similarity;
  }

  return left.movieId - right.movieId;
}

function comparePopularity(left: PreparedCandidate, right: PreparedCandidate): number {
  if (left.voteCount === null && right.voteCount === null) {
    return left.movieId - right.movieId;
  }

  if (left.voteCount === null) {
    return 1;
  }

  if (right.voteCount === null) {
    return -1;
  }

  if (left.voteCount !== right.voteCount) {
    return right.voteCount - left.voteCount;
  }

  return left.movieId - right.movieId;
}

function ranksBy(
  prepared: readonly PreparedCandidate[],
  compare: (left: PreparedCandidate, right: PreparedCandidate) => number,
): number[] {
  const order = prepared.map((_, index) => index);

  order.sort((leftIndex, rightIndex) => {
    const left = prepared[leftIndex];
    const right = prepared[rightIndex];

    if (left === undefined || right === undefined) {
      return leftIndex - rightIndex;
    }

    const difference = compare(left, right);

    return difference !== 0 ? difference : leftIndex - rightIndex;
  });

  const ranks = new Array<number>(prepared.length).fill(0);

  order.forEach((index, position) => {
    ranks[index] = position + 1;
  });

  return ranks;
}

function fusionBaseScores(
  prepared: readonly PreparedCandidate[],
  weight: number,
  k: number,
): number[] {
  const similarityRanks = ranksBy(prepared, compareSimilarity);
  const popularityRanks = ranksBy(prepared, comparePopularity);

  return prepared.map((_, index) => {
    const rankSimilarity = similarityRanks[index] ?? 1;
    const rankPopularity = popularityRanks[index] ?? 1;

    return 1 / (k + rankSimilarity) + weight / (k + rankPopularity);
  });
}

export interface DeepRerankOptions {
  limit: number;
  tiltWeight: number;
  penalty?: number;
  scoring?: RerankScoring;
}

function baseScoresFor(
  prepared: readonly PreparedCandidate[],
  options: DeepRerankOptions,
): number[] {
  const scoring = options.scoring ?? { mode: 'tilt' };

  switch (scoring.mode) {
    case 'tilt':
      return prepared.map(
        (candidate) => candidate.similarity + options.tiltWeight * candidate.quality,
      );
    case 'zscore':
      return zscoreBaseScores(prepared, scoring.weight);
    case 'fusion':
      return fusionBaseScores(prepared, scoring.weight, scoring.k ?? FUSION_DEFAULT_K);
  }
}

/**
 * The production greedy diversity rerank with a configurable limit and base
 * score. `selectDiverse` caps the limit at `MAX_RECOMMENDATIONS` and fixes the
 * tilt, so the evaluation needs its own copy to rank to depth 100 and to sweep
 * the scoring. The greedy loop, diversity penalty and tie-breaking mirror
 * `selectDiverse` exactly; `rank.test.ts` asserts the first four picks match it.
 */
export function deepRerank(
  candidates: readonly ScoredCandidate[],
  options: DeepRerankOptions,
): number[] {
  validatePositiveInteger(options.limit, 'limit');
  validateWeight(options.tiltWeight, 'tiltWeight');

  const penalty = options.penalty ?? DEFAULT_DIVERSITY_PENALTY;

  validatePenalty(penalty);

  if (options.scoring !== undefined) {
    validateScoring(options.scoring);
  }

  const prepared = prepareCandidates(candidates);
  const baseScores = baseScoresFor(prepared, options);
  const selected = new Array<boolean>(prepared.length).fill(false);
  const maxSelectedSimilarity = new Array<number>(prepared.length).fill(Number.NEGATIVE_INFINITY);
  const ranked: number[] = [];
  let selectedCount = 0;

  while (ranked.length < options.limit && ranked.length < prepared.length) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestMovieId = Number.POSITIVE_INFINITY;

    for (let index = 0; index < prepared.length; index += 1) {
      if (selected[index] === true) {
        continue;
      }

      const baseScore = baseScores[index] ?? 0;
      const score =
        selectedCount === 0 ? baseScore : baseScore - penalty * (maxSelectedSimilarity[index] ?? 0);
      const movieId = prepared[index]?.movieId ?? 0;

      if (score > bestScore || (score === bestScore && movieId < bestMovieId)) {
        bestIndex = index;
        bestScore = score;
        bestMovieId = movieId;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const picked = prepared[bestIndex];

    if (picked === undefined) {
      break;
    }

    selected[bestIndex] = true;
    ranked.push(bestMovieId);
    selectedCount += 1;

    for (let index = 0; index < prepared.length; index += 1) {
      if (selected[index] === true) {
        continue;
      }

      const other = prepared[index];

      if (other === undefined) {
        continue;
      }

      const similarity = preparedCosine(picked, other);

      if (similarity > (maxSelectedSimilarity[index] ?? Number.NEGATIVE_INFINITY)) {
        maxSelectedSimilarity[index] = similarity;
      }
    }
  }

  return ranked;
}

/**
 * Orders a candidate buffer by `similarity + weight * quality`, tie-breaking by
 * movie id. Unlike the rerank tilt, this changes which films the pool contains:
 * the experiments slice the buffer afterwards.
 */
export function tiltPool(
  candidates: readonly ScoredCandidate[],
  weight: number,
): ScoredCandidate[] {
  return orderPoolByQuality(candidates, weight);
}

export interface RankingSettings {
  /** Number of candidates the pool keeps after ordering. */
  poolSize: number;
  /** Quality tilt applied to the pool ordering; 0 keeps pure cosine order. */
  poolTiltWeight: number;
  /** Quality tilt applied inside the greedy rerank. */
  tiltWeight: number;
  /** Maximum length of the returned ranking (MRR scans all of it). */
  depth: number;
  /** Base-score formula for the greedy rerank; defaults to the production tilt. */
  scoring?: RerankScoring;
}

/**
 * The parameterised experiment path: order the buffer (optionally with the
 * pool-stage quality tilt), keep `poolSize` candidates, then rerun the greedy
 * diversity rank to `depth`. The production constants remain the defaults
 * wherever this is not called.
 */
export function rankCandidates(
  buffer: readonly ScoredCandidate[],
  settings: RankingSettings,
): number[] {
  validatePositiveInteger(settings.poolSize, 'poolSize');
  validateWeight(settings.poolTiltWeight, 'poolTiltWeight');
  validateWeight(settings.tiltWeight, 'tiltWeight');
  validatePositiveInteger(settings.depth, 'depth');

  const ordered =
    settings.poolTiltWeight === 0 ? buffer : tiltPool(buffer, settings.poolTiltWeight);
  const pool = ordered.slice(0, Math.min(settings.poolSize, ordered.length));

  if (pool.length === 0) {
    return [];
  }

  return deepRerank(pool, {
    limit: Math.min(settings.depth, pool.length),
    tiltWeight: settings.tiltWeight,
    ...(settings.scoring === undefined ? {} : { scoring: settings.scoring }),
  });
}
