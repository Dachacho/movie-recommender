import type { ScoredCandidate } from './types.js';

export const DEFAULT_DIVERSITY_PENALTY = 0.3;
export const MAX_RECOMMENDATIONS = 4;

/**
 * Product-approved reception tilt strength, raised from 0.12 to 0.50 on the
 * held-out evidence in docs/evaluation-experiments-2026-11-23.md: the rerank
 * tilt sweep was monotone from 0.05 to 0.50, and 0.50 beat the genre baseline on
 * every metric while still drawing a taste-selected pool. Within the
 * similarity-retrieved pool candidates within ~0.50 cosine similarity can be
 * reordered by reception, though taste still selects the pool and larger
 * similarity gaps still win. It remains interim pending future evaluation
 * rounds; retune against held-out evidence before changing it.
 */
export const QUALITY_TILT_WEIGHT = 0.5;

/**
 * Divisor that scales the log vote count. log10(1 + 10M) = 7.0, so a ~10M-vote
 * film normalizes to 7 / 6 = 1.17 and clamps to 1, while a ~100-vote film
 * normalizes to log10(101) / 6 = 0.334.
 */
export const LOG_VOTE_SCALE = 6;

const VOTE_COUNT_WEIGHT = 0.3;
const VOTE_AVERAGE_WEIGHT = 0.7;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Pure reception score in [0, 1]: 0.3 * log-scaled vote count plus 0.7 * the
 * vote average on a ten-point scale, so the rating is the dominant signal while
 * vote count still separates thinly rated films. Null fields contribute 0, and
 * inputs are clamped so malformed data cannot amplify the tilt.
 */
export function qualityScore(voteAverage: number | null, voteCount: number | null): number {
  const votes =
    voteCount === null || !Number.isFinite(voteCount)
      ? 0
      : clampUnit(Math.log10(1 + Math.max(0, voteCount)) / LOG_VOTE_SCALE);
  const average =
    voteAverage === null || !Number.isFinite(voteAverage) ? 0 : clampUnit(voteAverage / 10);

  return VOTE_COUNT_WEIGHT * votes + VOTE_AVERAGE_WEIGHT * average;
}

function relevance(candidate: ScoredCandidate): number {
  const tilt = QUALITY_TILT_WEIGHT * qualityScore(candidate.voteAverage, candidate.voteCount);

  return candidate.similarity + tilt;
}

export interface SelectedRecommendation {
  movieId: number;
  similarity: number;
  score: number;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOMMENDATIONS) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_RECOMMENDATIONS}, received ${limit}.`,
    );
  }
}

function validatePenalty(penalty: number): void {
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 1) {
    throw new RangeError(`penalty must be a finite number between 0 and 1, received ${penalty}.`);
  }
}

function validateCandidates(candidates: readonly ScoredCandidate[]): void {
  const seenIds = new Set<number>();
  let dimensions: number | undefined;

  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.movieId) || candidate.movieId <= 0) {
      throw new RangeError(
        `candidates must contain only positive integer movieIds, received ${candidate.movieId}.`,
      );
    }

    if (seenIds.has(candidate.movieId)) {
      throw new RangeError(
        `candidates must not contain duplicate movieIds, received ${candidate.movieId}.`,
      );
    }
    seenIds.add(candidate.movieId);

    if (!Number.isFinite(candidate.similarity)) {
      throw new RangeError(
        `movie ${candidate.movieId} similarity must be a finite number, received ${candidate.similarity}.`,
      );
    }

    if (candidate.embedding.length === 0) {
      throw new RangeError(`movie ${candidate.movieId} embedding must not be empty.`);
    }

    for (let index = 0; index < candidate.embedding.length; index += 1) {
      const value = candidate.embedding[index];

      if (value === undefined || !Number.isFinite(value)) {
        throw new RangeError(
          `movie ${candidate.movieId} embedding[${index}] must be a finite number, received ${value}.`,
        );
      }
    }

    if (dimensions === undefined) {
      dimensions = candidate.embedding.length;
    } else if (candidate.embedding.length !== dimensions) {
      throw new RangeError(
        `movie ${candidate.movieId} embedding must have ${dimensions} dimensions, received ${candidate.embedding.length}.`,
      );
    }
  }
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

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const leftMax = maxAbsoluteComponent(left);
  const rightMax = maxAbsoluteComponent(right);

  if (leftMax === 0 || rightMax === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftSquared = 0;
  let rightSquared = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = (left[index] ?? 0) / leftMax;
    const rightValue = (right[index] ?? 0) / rightMax;

    dotProduct += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }

  return dotProduct / (Math.sqrt(leftSquared) * Math.sqrt(rightSquared));
}

function scoreCandidate(
  candidate: ScoredCandidate,
  selected: readonly ScoredCandidate[],
  penalty: number,
): number {
  const baseScore = relevance(candidate);

  if (selected.length === 0) {
    return baseScore;
  }

  let maxSelectedSimilarity = Number.NEGATIVE_INFINITY;

  for (const picked of selected) {
    const similarity = cosineSimilarity(candidate.embedding, picked.embedding);

    if (similarity > maxSelectedSimilarity) {
      maxSelectedSimilarity = similarity;
    }
  }

  return baseScore - penalty * maxSelectedSimilarity;
}

export function selectDiverse(
  candidates: readonly ScoredCandidate[],
  options: { limit: number; penalty?: number },
): SelectedRecommendation[] {
  validateLimit(options.limit);

  const penalty = options.penalty ?? DEFAULT_DIVERSITY_PENALTY;

  validatePenalty(penalty);
  validateCandidates(candidates);

  const selected: ScoredCandidate[] = [];
  const selectedIds = new Set<number>();
  const recommendations: SelectedRecommendation[] = [];

  while (recommendations.length < options.limit) {
    let best: { candidate: ScoredCandidate; score: number } | undefined;

    for (const candidate of candidates) {
      if (selectedIds.has(candidate.movieId)) {
        continue;
      }

      const score = scoreCandidate(candidate, selected, penalty);

      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && candidate.movieId < best.candidate.movieId)
      ) {
        best = { candidate, score };
      }
    }

    if (best === undefined) {
      break;
    }

    selected.push(best.candidate);
    selectedIds.add(best.candidate.movieId);
    recommendations.push({
      movieId: best.candidate.movieId,
      similarity: best.candidate.similarity,
      score: best.score,
    });
  }

  return recommendations;
}
