import {
  EXPECTED_EMBEDDING_DIMENSIONS,
  type RecommendationFilters,
} from '../modules/recommendations/types.js';
import type { GenreWeights, PromptCaseGroup } from './prompt-cases.js';

/**
 * Seed for the synthetic taste vector used by the offline prompt harness. The
 * vector is not a real user and no guest data is involved: it is a fixed unit
 * direction so every run ranks prompts against the same taste signal.
 */
export const SYNTHETIC_TASTE_SEED = 0x5eed1a57;
export const SYNTHETIC_TASTE_DIMENSIONS = EXPECTED_EMBEDDING_DIMENSIONS;

/** Small, documented mulberry32 PRNG: same seed, same sequence on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic 384-d unit vector derived from a seed, used as the fixed taste persona. */
export function createSyntheticTasteVector(
  seed: number = SYNTHETIC_TASTE_SEED,
  dimensions: number = SYNTHETIC_TASTE_DIMENSIONS,
): number[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError(`seed must be an integer from 0 to 4294967295, received ${seed}.`);
  }

  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(`dimensions must be a positive integer, received ${dimensions}.`);
  }

  const random = mulberry32(seed);
  const values = Array.from({ length: dimensions }, () => random() * 2 - 1);
  const norm = Math.hypot(...values);

  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error('Synthetic taste vector failed to produce a non-zero norm.');
  }

  return values.map((value) => value / norm);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError(
      `vectors must have the same dimensions, received ${left.length} and ${right.length}.`,
    );
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];

    if (
      leftValue === undefined ||
      rightValue === undefined ||
      !Number.isFinite(leftValue) ||
      !Number.isFinite(rightValue)
    ) {
      throw new RangeError(`vectors must contain only finite numbers at index ${index}.`);
    }

    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);

  if (denominator <= 0) {
    throw new RangeError('cosine similarity is undefined for a zero-length vector.');
  }

  return dot / denominator;
}

/** The catalog fields a pick needs for constraint and genre scoring. */
export interface PickMetadata {
  movieId: number;
  releaseYear: number | null;
  runtime: number | null;
  genres: readonly string[];
  embedding: readonly number[];
}

/**
 * Mirrors the SQL filter semantics: year and runtime bounds exclude nulls, and
 * genres are an OR (array overlap).
 */
export function satisfiesFilters(movie: PickMetadata, filters: RecommendationFilters): boolean {
  if (
    filters.runtimeMin !== undefined &&
    (movie.runtime === null || movie.runtime < filters.runtimeMin)
  ) {
    return false;
  }

  if (
    filters.runtimeMax !== undefined &&
    (movie.runtime === null || movie.runtime > filters.runtimeMax)
  ) {
    return false;
  }

  if (
    filters.yearMin !== undefined &&
    (movie.releaseYear === null || movie.releaseYear < filters.yearMin)
  ) {
    return false;
  }

  if (
    filters.yearMax !== undefined &&
    (movie.releaseYear === null || movie.releaseYear > filters.yearMax)
  ) {
    return false;
  }

  const genres = filters.genres;

  if (genres !== undefined && genres.length > 0) {
    return movie.genres.some((genre) => genres.includes(genre));
  }

  return true;
}

/** Graded relevance of one film: the strongest weight among its genres, else 0. */
export function genreRelevance(movieGenres: readonly string[], genreWeights: GenreWeights): number {
  let best = 0;

  for (const genre of movieGenres) {
    const weight = genreWeights[genre as keyof GenreWeights];

    if (weight !== undefined && weight > best) {
      best = weight;
    }
  }

  return best;
}

export interface PromptSelection {
  group: PromptCaseGroup;
  expectedFilters: RecommendationFilters | undefined;
  genreWeights: GenreWeights;
  /** Picks in rank order, at most the metric depth. */
  picks: readonly PickMetadata[];
}

export interface SelectionScore {
  empty: boolean;
  /** Every returned pick satisfies the expected filters; undefined when there are none. */
  satisfiesFilters: boolean | undefined;
  /** Same check restricted to cases that returned at least one pick. */
  nonEmptySatisfiesFilters: boolean | undefined;
  /** Mean graded relevance across returned picks; 0 when the case returned nothing. */
  genrePrecision: number | undefined;
  /** Mean cosine to the synthetic taste vector over returned picks; undefined when empty. */
  tasteSimilarity: number | undefined;
}

export function scoreSelection(
  selection: PromptSelection,
  tasteVector: readonly number[],
): SelectionScore {
  const empty = selection.picks.length === 0;
  const expectedFilters = selection.expectedFilters;
  const satisfies =
    expectedFilters === undefined
      ? undefined
      : selection.picks.every((pick) => satisfiesFilters(pick, expectedFilters));

  const hasGenreWeights = Object.keys(selection.genreWeights).length > 0;
  let genrePrecision: number | undefined;

  if (hasGenreWeights) {
    genrePrecision =
      selection.picks.length === 0
        ? 0
        : average(
            selection.picks.map((pick) => genreRelevance(pick.genres, selection.genreWeights)),
          );
  }

  const tasteSimilarity = empty
    ? undefined
    : average(selection.picks.map((pick) => cosineSimilarity(pick.embedding, tasteVector)));

  return {
    empty,
    satisfiesFilters: satisfies,
    nonEmptySatisfiesFilters: satisfies === undefined || empty ? undefined : satisfies,
    genrePrecision,
    tasteSimilarity,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface PromptWeightScore {
  cases: number;
  emptyResults: number;
  constraintCases: number;
  constraintSatisfiedCases: number;
  constraintNonEmptyCases: number;
  constraintSatisfiedNonEmptyCases: number;
  constraintSatisfaction: number;
  constraintSatisfactionNonEmpty: number;
  genreCases: number;
  genreHardCases: number;
  genreSoftCases: number;
  genrePrecisionAll: number;
  genrePrecisionHard: number;
  genrePrecisionSoft: number;
  tasteCases: number;
  tasteSimilarity: number;
}

/**
 * Aggregates one weight configuration. Genre precision averages per-case means
 * over every labelled case, counting an empty result as 0; taste similarity
 * averages only cases that returned picks because a missing pick has no cosine.
 */
export function scoreSelections(
  selections: readonly PromptSelection[],
  tasteVector: readonly number[],
): PromptWeightScore {
  const scores = selections.map((selection) => scoreSelection(selection, tasteVector));
  let constraintCases = 0;
  let constraintSatisfiedCases = 0;
  let constraintNonEmptyCases = 0;
  let constraintSatisfiedNonEmptyCases = 0;
  const allGenre: number[] = [];
  const hardGenre: number[] = [];
  const softGenre: number[] = [];
  const taste: number[] = [];

  selections.forEach((selection, index) => {
    const score = scores[index];

    if (score === undefined) {
      return;
    }

    if (score.satisfiesFilters !== undefined) {
      constraintCases += 1;

      if (score.satisfiesFilters) {
        constraintSatisfiedCases += 1;
      }

      if (score.nonEmptySatisfiesFilters !== undefined) {
        constraintNonEmptyCases += 1;

        if (score.nonEmptySatisfiesFilters) {
          constraintSatisfiedNonEmptyCases += 1;
        }
      }
    }

    if (score.genrePrecision !== undefined) {
      allGenre.push(score.genrePrecision);

      if (selection.group === 'soft') {
        softGenre.push(score.genrePrecision);
      } else if (selection.expectedFilters !== undefined) {
        hardGenre.push(score.genrePrecision);
      }
    }

    if (score.tasteSimilarity !== undefined) {
      taste.push(score.tasteSimilarity);
    }
  });

  return {
    cases: selections.length,
    emptyResults: scores.filter((score) => score.empty).length,
    constraintCases,
    constraintSatisfiedCases,
    constraintNonEmptyCases,
    constraintSatisfiedNonEmptyCases,
    constraintSatisfaction: constraintCases === 0 ? 0 : constraintSatisfiedCases / constraintCases,
    constraintSatisfactionNonEmpty:
      constraintNonEmptyCases === 0
        ? 0
        : constraintSatisfiedNonEmptyCases / constraintNonEmptyCases,
    genreCases: allGenre.length,
    genreHardCases: hardGenre.length,
    genreSoftCases: softGenre.length,
    genrePrecisionAll: average(allGenre),
    genrePrecisionHard: average(hardGenre),
    genrePrecisionSoft: average(softGenre),
    tasteCases: taste.length,
    tasteSimilarity: average(taste),
  };
}
