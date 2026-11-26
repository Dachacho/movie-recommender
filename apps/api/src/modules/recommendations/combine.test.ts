import { describe, expect, it } from 'vitest';
import { combineQueryVector } from './combine.js';
import { EXPECTED_EMBEDDING_DIMENSIONS } from './types.js';

function axisVector(axis: number): number[] {
  const vector = new Array<number>(EXPECTED_EMBEDDING_DIMENSIONS).fill(0);
  vector[axis] = 1;

  return vector;
}

function at(vector: readonly number[], index: number): number {
  return vector[index] ?? Number.NaN;
}

describe('combineQueryVector', () => {
  it('combines taste and prompt with equal weighting and normalizes the result', () => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(0);
    tasteVector[0] = Math.SQRT1_2;
    tasteVector[1] = Math.SQRT1_2;

    const combined = combineQueryVector({ promptVector, tasteVector });

    expect(combined).not.toBeNull();
    if (combined === null) {
      throw new Error('expected a combined query vector');
    }

    // Equal weights place the result halfway between the two directions (22.5 degrees).
    expect(combined).toHaveLength(EXPECTED_EMBEDDING_DIMENSIONS);
    expect(at(combined, 0)).toBeCloseTo(Math.cos(Math.PI / 8), 12);
    expect(at(combined, 1)).toBeCloseTo(Math.sin(Math.PI / 8), 12);
    expect(at(combined, 2)).toBeCloseTo(0, 12);
    expect(Math.hypot(...combined)).toBeCloseTo(1, 12);
  });

  it('uses the production weights when no weights are provided', () => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(1);

    expect(combineQueryVector({ promptVector, tasteVector })).toEqual(
      combineQueryVector({ promptVector, tasteVector, promptWeight: 0.5, tasteWeight: 0.5 }),
    );
  });

  it('combines vectors with explicit prompt and taste weights', () => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(1);
    const combined = combineQueryVector({
      promptVector,
      tasteVector,
      promptWeight: 0.8,
      tasteWeight: 0.2,
    });

    expect(combined).not.toBeNull();
    if (combined === null) {
      throw new Error('expected a combined query vector');
    }

    const norm = Math.hypot(0.8, 0.2);
    expect(at(combined, 0)).toBeCloseTo(0.8 / norm, 12);
    expect(at(combined, 1)).toBeCloseTo(0.2 / norm, 12);
    expect(at(combined, 2)).toBeCloseTo(0, 12);
    expect(Math.hypot(...combined)).toBeCloseTo(1, 12);
  });

  it('favours the prompt vector at prompt weight 1 and taste weight 0', () => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(1);

    expect(
      combineQueryVector({ promptVector, tasteVector, promptWeight: 1, tasteWeight: 0 }),
    ).toEqual(promptVector);
  });

  it.each([
    ['promptWeight', { promptWeight: Number.NaN }],
    ['promptWeight', { promptWeight: Number.POSITIVE_INFINITY }],
    ['promptWeight', { promptWeight: -0.1 }],
    ['tasteWeight', { tasteWeight: Number.NaN }],
    ['tasteWeight', { tasteWeight: Number.NEGATIVE_INFINITY }],
    ['tasteWeight', { tasteWeight: -1 }],
  ])('rejects invalid %s values', (name, weights) => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(1);

    expect(() => combineQueryVector({ promptVector, tasteVector, ...weights })).toThrow(RangeError);
    expect(() => combineQueryVector({ promptVector, tasteVector, ...weights })).toThrow(
      new RegExp(`${name} must be a finite, non-negative number`),
    );
  });

  it('returns the prompt vector when there is no taste vector', () => {
    const promptVector = axisVector(1);

    expect(combineQueryVector({ promptVector })).toEqual(promptVector);
    expect(combineQueryVector({ promptVector, tasteVector: null })).toEqual(promptVector);
  });

  it('returns the taste vector when there is no prompt vector', () => {
    const tasteVector = axisVector(2);

    expect(combineQueryVector({ tasteVector })).toEqual(tasteVector);
    expect(combineQueryVector({ promptVector: null, tasteVector })).toEqual(tasteVector);
  });

  it('returns null when neither vector is present', () => {
    expect(combineQueryVector({})).toBeNull();
    expect(combineQueryVector({ promptVector: null, tasteVector: null })).toBeNull();
  });

  it('falls back to the prompt vector when the combination is near zero', () => {
    const promptVector = axisVector(0);
    const tasteVector = axisVector(0);
    tasteVector[0] = -1;
    tasteVector[1] = 1e-10;

    expect(combineQueryVector({ promptVector, tasteVector })).toEqual(promptVector);
  });

  it('rejects vectors with the wrong number of dimensions', () => {
    const shortVector = axisVector(0).slice(0, EXPECTED_EMBEDDING_DIMENSIONS - 1);

    expect(() => combineQueryVector({ promptVector: shortVector })).toThrow(RangeError);
    expect(() => combineQueryVector({ promptVector: shortVector })).toThrow(
      /promptVector must have exactly 384 dimensions, received 383/,
    );
    expect(() => combineQueryVector({ tasteVector: shortVector })).toThrow(
      /tasteVector must have exactly 384 dimensions, received 383/,
    );
  });

  it('rejects vectors that contain non-finite values', () => {
    const nonFinite = axisVector(0);
    nonFinite[0] = Number.NaN;

    expect(() => combineQueryVector({ promptVector: nonFinite })).toThrow(RangeError);
    expect(() => combineQueryVector({ promptVector: nonFinite })).toThrow(
      /promptVector\[0\] must be a finite number/,
    );
    expect(() => combineQueryVector({ tasteVector: nonFinite })).toThrow(
      /tasteVector\[0\] must be a finite number/,
    );
  });
});
