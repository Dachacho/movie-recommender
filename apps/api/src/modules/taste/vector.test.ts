import { describe, expect, it } from 'vitest';
import type { RatedEmbedding } from './vector.js';
import { computeTasteVector, MIN_TASTE_NORM, TASTE_BASELINE } from './vector.js';

function rated(movieId: number, rating: number, embedding: number[]): RatedEmbedding {
  return { movieId, rating, embedding };
}

function expectVector(actual: number[] | null): number[] {
  if (actual === null) {
    throw new Error('expected a taste vector, received null');
  }

  return actual;
}

function at(vector: readonly number[], index: number): number {
  return vector[index] ?? Number.NaN;
}

describe('computeTasteVector', () => {
  it('returns the unit direction of a single five-star rating', () => {
    const vector = expectVector(computeTasteVector([rated(1, 5, [3, 4, 0])]));

    expect(vector).toEqual([0.6, 0.8, 0]);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
  });

  it('returns the opposite direction for a single half-star rating', () => {
    const vector = expectVector(computeTasteVector([rated(1, 0.5, [3, 4, 0])]));

    expect(vector).toEqual([-0.6, -0.8, 0]);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
  });

  it('sums weighted embeddings and normalizes the result', () => {
    // weights: 4.5 - 2.5 = 2 and 1.5 - 2.5 = -1, so the sum is [2, -2, 0].
    const vector = expectVector(
      computeTasteVector([rated(1, 4.5, [1, 0, 0]), rated(2, 1.5, [0, 2, 0])]),
    );

    expect(vector).toHaveLength(3);
    expect(at(vector, 0)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(at(vector, 1)).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(at(vector, 2)).toBeCloseTo(0, 12);
  });

  it('returns null when every rating sits exactly on the baseline', () => {
    expect(
      computeTasteVector([
        rated(1, TASTE_BASELINE, [1, 2, 3]),
        rated(2, TASTE_BASELINE, [4, 5, 6]),
      ]),
    ).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(computeTasteVector([])).toBeNull();
  });

  it('returns null when weighted embeddings cancel exactly', () => {
    // both ratings weigh +2 and their embeddings point in opposite directions.
    expect(computeTasteVector([rated(1, 4.5, [1, 0, 0]), rated(2, 4.5, [-1, 0, 0])])).toBeNull();
  });

  it('returns null when the norm is at or below the epsilon', () => {
    expect(computeTasteVector([rated(1, 5, [MIN_TASTE_NORM / 100, 0, 0])])).toBeNull();
    // Weight 0.5 halves the exact double below, so the norm equals MIN_TASTE_NORM exactly.
    expect(computeTasteVector([rated(1, 3, [MIN_TASTE_NORM * 2])])).toBeNull();
  });

  it('returns null when the weighted sum overflows to a non-finite norm', () => {
    expect(computeTasteVector([rated(1, 5, [1e308, 1e308, 0])])).toBeNull();
  });

  it('normalizes a finite norm that would overflow when squared', () => {
    expect(computeTasteVector([rated(1, 3, [1e200])])).toEqual([1]);
  });

  it('rejects sparse embeddings', () => {
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    sparse[2] = 0;

    expect(() => computeTasteVector([rated(1, 5, sparse)])).toThrow(RangeError);
    expect(() => computeTasteVector([rated(1, 5, sparse)])).toThrow(/movieId 1/);
  });

  it('normalizes embeddings on large dimensions', () => {
    const embedding = new Array<number>(200_000).fill(0);
    embedding[0] = 1;

    const vector = expectVector(computeTasteVector([rated(1, 5, embedding)]));

    expect(vector).toHaveLength(200_000);
    expect(at(vector, 0)).toBeCloseTo(1, 12);
    expect(at(vector, 199_999)).toBeCloseTo(0, 12);
  });

  it.each([0, 5.5, 2.7, Number.NaN])('rejects the invalid rating %s', (rating) => {
    expect(() => computeTasteVector([rated(42, rating, [1, 0, 0])])).toThrow(RangeError);
    expect(() => computeTasteVector([rated(42, rating, [1, 0, 0])])).toThrow(/movieId 42/);
  });

  it('rejects embeddings of different lengths', () => {
    expect(() => computeTasteVector([rated(1, 5, [1, 0, 0]), rated(2, 4, [1, 0])])).toThrow(
      /movieId 2/,
    );
  });

  it('rejects non-finite embedding values', () => {
    expect(() => computeTasteVector([rated(7, 5, [1, Number.POSITIVE_INFINITY, 0])])).toThrow(
      RangeError,
    );
    expect(() => computeTasteVector([rated(7, 5, [Number.NaN, 0, 0])])).toThrow(/movieId 7/);
  });

  it('rejects empty embeddings', () => {
    expect(() => computeTasteVector([rated(3, 5, [])])).toThrow(/movieId 3/);
  });

  it('rejects duplicate movie ids', () => {
    expect(() => computeTasteVector([rated(1, 5, [1, 0, 0]), rated(1, 1, [0, 1, 0])])).toThrow(
      /movieId 1/,
    );
  });

  it.each([0, -3, 2.5, Number.NaN])('rejects the invalid movieId %s', (movieId) => {
    expect(() => computeTasteVector([rated(movieId, 5, [1, 0, 0])])).toThrow(RangeError);
  });

  it('returns identical output for repeated calls with the same input', () => {
    const input = [rated(1, 4.5, [1, 0, 0]), rated(2, 1.5, [0, 2, 0])];

    expect(computeTasteVector(input)).toEqual(computeTasteVector(input));
  });
});
