import { describe, expect, it } from 'vitest';
import { EXPECTED_EMBEDDING_DIMENSIONS } from '../modules/recommendations/types.js';
import {
  SYNTHETIC_TASTE_DIMENSIONS,
  cosineSimilarity,
  createSyntheticTasteVector,
  genreRelevance,
  satisfiesFilters,
  scoreSelection,
  scoreSelections,
  type PickMetadata,
  type PromptSelection,
} from './prompt-metrics.js';

function axisVector(axis: number, dimensions = EXPECTED_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[axis] = 1;

  return vector;
}

function pick(overrides: Partial<PickMetadata> = {}): PickMetadata {
  return {
    movieId: 1,
    releaseYear: 2000,
    runtime: 100,
    genres: ['Drama'],
    embedding: axisVector(0),
    ...overrides,
  };
}

function selection(overrides: Partial<PromptSelection> = {}): PromptSelection {
  return {
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: {},
    picks: [],
    ...overrides,
  };
}

describe('synthetic taste vector', () => {
  it('is deterministic and unit length', () => {
    const first = createSyntheticTasteVector();
    const second = createSyntheticTasteVector();

    expect(first).toHaveLength(SYNTHETIC_TASTE_DIMENSIONS);
    expect(first).toEqual(second);
    expect(Math.hypot(...first)).toBeCloseTo(1, 12);
    expect(first.every((value) => Number.isFinite(value))).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it('depends on the seed and dimensions', () => {
    expect(createSyntheticTasteVector(1)).not.toEqual(createSyntheticTasteVector(2));
    expect(createSyntheticTasteVector(1, 4)).toHaveLength(4);
    expect(Math.hypot(...createSyntheticTasteVector(1, 4))).toBeCloseTo(1, 12);
  });

  it.each([
    ['negative seed', -1, 384],
    ['non-integer seed', 1.5, 384],
    ['zero dimensions', 1, 0],
    ['non-integer dimensions', 1, 2.5],
  ])('rejects a %s', (_name, seed, dimensions) => {
    expect(() => createSyntheticTasteVector(seed, dimensions)).toThrow(RangeError);
  });
});

describe('cosineSimilarity', () => {
  it('scores identical and orthogonal vectors', () => {
    const left = createSyntheticTasteVector();

    expect(cosineSimilarity(left, left)).toBeCloseTo(1, 12);
    expect(cosineSimilarity(axisVector(0), axisVector(1))).toBeCloseTo(0, 12);
  });

  it('rejects mismatched dimensions and zero vectors', () => {
    expect(() => cosineSimilarity(axisVector(0), axisVector(0, 2))).toThrow(RangeError);
    expect(() => cosineSimilarity(axisVector(0), axisVector(1))).not.toThrow();
    expect(() =>
      cosineSimilarity(new Array<number>(EXPECTED_EMBEDDING_DIMENSIONS).fill(0), axisVector(0)),
    ).toThrow(/zero-length vector/);
  });
});

describe('satisfiesFilters', () => {
  it('treats genres as OR and bounds as inclusive', () => {
    const movie = pick({ releaseYear: 1990, runtime: 90, genres: ['Comedy', 'Horror'] });

    expect(satisfiesFilters(movie, { genres: ['Comedy'] })).toBe(true);
    expect(satisfiesFilters(movie, { genres: ['Drama', 'Horror'] })).toBe(true);
    expect(satisfiesFilters(movie, { genres: ['Drama'] })).toBe(false);
    expect(satisfiesFilters(movie, { genres: [] })).toBe(true);
    expect(satisfiesFilters(movie, { yearMin: 1990, yearMax: 1999 })).toBe(true);
    expect(satisfiesFilters(movie, { runtimeMin: 90, runtimeMax: 120 })).toBe(true);
  });

  it('rejects values outside the bounds or with a missing field', () => {
    const movie = pick({ releaseYear: 1989, runtime: 89 });

    expect(satisfiesFilters(movie, { yearMin: 1990 })).toBe(false);
    expect(satisfiesFilters(movie, { yearMax: 1988 })).toBe(false);
    expect(satisfiesFilters(movie, { runtimeMin: 90 })).toBe(false);
    expect(satisfiesFilters(movie, { runtimeMax: 88 })).toBe(false);
    expect(satisfiesFilters(pick({ releaseYear: null }), { yearMin: 1990 })).toBe(false);
    expect(satisfiesFilters(pick({ runtime: null }), { runtimeMax: 120 })).toBe(false);
  });
});

describe('genreRelevance', () => {
  it('takes the strongest matching genre weight and zero when nothing matches', () => {
    expect(genreRelevance(['Comedy', 'Drama'], { Comedy: 0.5, Drama: 0.9, Horror: 1 })).toBe(0.9);
    expect(genreRelevance(['Comedy'], { Comedy: 0.5, Drama: 0.9 })).toBe(0.5);
    expect(genreRelevance(['Western'], { Comedy: 0.5, Drama: 0.9 })).toBe(0);
    expect(genreRelevance([], { Comedy: 0.5 })).toBe(0);
  });
});

describe('scoreSelection', () => {
  it('scores satisfaction, graded genre precision and taste similarity', () => {
    const taste = axisVector(0);
    const score = scoreSelection(
      selection({
        expectedFilters: { runtimeMax: 100 },
        genreWeights: { Comedy: 1, Drama: 0.5 },
        picks: [
          pick({ movieId: 1, genres: ['Comedy'], embedding: axisVector(0) }),
          pick({ movieId: 2, genres: ['Drama'], embedding: axisVector(1) }),
        ],
      }),
      taste,
    );

    expect(score.empty).toBe(false);
    expect(score.satisfiesFilters).toBe(true);
    expect(score.nonEmptySatisfiesFilters).toBe(true);
    expect(score.genrePrecision).toBeCloseTo(0.75, 12);
    expect(score.tasteSimilarity).toBeCloseTo(0.5, 12);
  });

  it('handles an empty result and no expected filters', () => {
    const score = scoreSelection(
      selection({ expectedFilters: { genres: ['Comedy'] }, genreWeights: { Comedy: 1 } }),
      axisVector(0),
    );

    expect(score.empty).toBe(true);
    expect(score.satisfiesFilters).toBe(true);
    expect(score.nonEmptySatisfiesFilters).toBeUndefined();
    expect(score.genrePrecision).toBe(0);
    expect(score.tasteSimilarity).toBeUndefined();

    const control = scoreSelection(selection(), axisVector(0));

    expect(control.satisfiesFilters).toBeUndefined();
    expect(control.genrePrecision).toBeUndefined();
  });
});

describe('scoreSelections', () => {
  it('reports filter and genre metrics separately for hard and soft cases', () => {
    const taste = axisVector(0);
    const hard = selection({
      group: 'explicit',
      expectedFilters: { genres: ['Comedy'] },
      genreWeights: { Comedy: 1 },
      picks: [pick({ genres: ['Comedy'] })],
    });
    const soft = selection({
      group: 'soft',
      genreWeights: { Drama: 1 },
      picks: [
        pick({ movieId: 2, genres: ['Drama'], embedding: axisVector(0) }),
        pick({ movieId: 3, genres: ['Drama'], embedding: axisVector(1) }),
      ],
    });
    const emptySoft = selection({
      group: 'soft',
      genreWeights: { Comedy: 1 },
      picks: [],
    });
    const control = selection({ group: 'control' });
    const score = scoreSelections([hard, soft, emptySoft, control], taste);

    expect(score.cases).toBe(4);
    expect(score.emptyResults).toBe(2);
    expect(score.constraintCases).toBe(1);
    expect(score.constraintSatisfiedCases).toBe(1);
    expect(score.constraintNonEmptyCases).toBe(1);
    expect(score.constraintSatisfaction).toBe(1);
    expect(score.genreCases).toBe(3);
    expect(score.genreHardCases).toBe(1);
    expect(score.genreSoftCases).toBe(2);
    expect(score.genrePrecisionHard).toBe(1);
    expect(score.genrePrecisionSoft).toBe(0.5);
    expect(score.genrePrecisionAll).toBeCloseTo(2 / 3, 12);
    expect(score.tasteCases).toBe(2);
    expect(score.tasteSimilarity).toBeCloseTo(0.75, 12);
  });
});
