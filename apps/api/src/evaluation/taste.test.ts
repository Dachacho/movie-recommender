import { describe, expect, it } from 'vitest';
import type { MappedRating } from './load.js';
import { buildTasteVector } from './taste.js';

function rating(movieId: number, value: number): MappedRating {
  return { userId: 1, movieId, rating: value, timestamp: movieId };
}

describe('buildTasteVector', () => {
  it('reuses the production calculation over train ratings with embeddings', () => {
    const result = buildTasteVector(
      [rating(1, 5), rating(2, 1.5)],
      new Map([
        [1, [3, 4, 0]],
        [2, [0, 2, 0]],
      ]),
    );

    expect(result.vector).not.toBeNull();
    expect(Math.hypot(...(result.vector ?? []))).toBeCloseTo(1, 12);
    expect(result.usedRatings).toBe(2);
    expect(result.missingEmbeddings).toBe(0);
  });

  it('skips films without an embedding and counts them', () => {
    const result = buildTasteVector([rating(1, 5), rating(2, 4)], new Map([[1, [1, 0]]]));

    expect(result.vector).toEqual([1, 0]);
    expect(result.usedRatings).toBe(1);
    expect(result.missingEmbeddings).toBe(1);
  });

  it('returns a cold-start null when no train film has an embedding', () => {
    expect(buildTasteVector([rating(1, 5)], new Map())).toEqual({
      vector: null,
      usedRatings: 0,
      missingEmbeddings: 1,
    });
    expect(buildTasteVector([], new Map())).toEqual({
      vector: null,
      usedRatings: 0,
      missingEmbeddings: 0,
    });
  });

  it('returns a cold-start null for a zero-norm taste', () => {
    expect(buildTasteVector([rating(1, 2.5)], new Map([[1, [1, 0]]]))).toEqual({
      vector: null,
      usedRatings: 1,
      missingEmbeddings: 0,
    });
  });
});
