import { describe, expect, it } from 'vitest';
import { ratingFromHalfStarPosition, starFill } from './libraryRatings';

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

describe('starFill', () => {
  it('fills stars below the rating completely', () => {
    expect(starFill(4.5, 1)).toBe('full');
    expect(starFill(4.5, 4)).toBe('full');
  });

  it('fills the star containing a half step halfway', () => {
    expect(starFill(0.5, 1)).toBe('half');
    expect(starFill(2.5, 3)).toBe('half');
    expect(starFill(4.5, 5)).toBe('half');
  });

  it('leaves stars above the rating empty', () => {
    expect(starFill(0.5, 2)).toBe('empty');
    expect(starFill(2.5, 4)).toBe('empty');
    expect(starFill(0, 1)).toBe('empty');
  });

  it('fills the last star completely at five stars', () => {
    expect(starFill(5, 5)).toBe('full');
  });
});
