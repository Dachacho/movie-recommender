import { describe, expect, it } from 'vitest';
import { ratingFromHalfStarPosition } from './libraryRatings';

describe('ratingFromHalfStarPosition', () => {
  it.each([
    [1, 0.5],
    [2, 1],
    [3, 1.5],
    [9, 4.5],
    [10, 5],
  ])('maps half-star position %s to rating %s', (position, rating) => {
    expect(ratingFromHalfStarPosition(position)).toBe(rating);
  });

  it('clamps positions outside the ten half-star steps', () => {
    expect(ratingFromHalfStarPosition(0)).toBe(0.5);
    expect(ratingFromHalfStarPosition(-4)).toBe(0.5);
    expect(ratingFromHalfStarPosition(11)).toBe(5);
  });

  it('rounds fractional positions to the nearest half star', () => {
    expect(ratingFromHalfStarPosition(4.4)).toBe(2);
    expect(ratingFromHalfStarPosition(4.5)).toBe(2.5);
  });

  it('falls back to the lowest rating for non-finite positions', () => {
    expect(ratingFromHalfStarPosition(Number.NaN)).toBe(0.5);
    expect(ratingFromHalfStarPosition(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});
