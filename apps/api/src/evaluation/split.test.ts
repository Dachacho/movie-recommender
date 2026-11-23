import { describe, expect, it } from 'vitest';
import type { MappedRating } from './load.js';
import { MIN_USER_RATINGS, splitRatings } from './split.js';

function rating(userId: number, movieId: number, timestamp: number, value = 5): MappedRating {
  return { userId, movieId, rating: value, timestamp };
}

function ratingsFor(userId: number, count: number): MappedRating[] {
  return Array.from({ length: count }, (_, index) => rating(userId, index + 1, 1_000 + index));
}

describe('splitRatings', () => {
  it('splits each user by timestamp, keeping the oldest 80% for training', () => {
    const { splits } = splitRatings(ratingsFor(1, 10).reverse());

    expect(splits).toHaveLength(1);
    expect(splits[0]?.train.map((entry) => entry.movieId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(splits[0]?.test.map((entry) => entry.movieId)).toEqual([9, 10]);
  });

  it('breaks equal timestamps by movie id so the split is deterministic', () => {
    const sameTimestamp = Array.from({ length: 10 }, (_, index) => rating(1, index + 1, 42));

    const { splits } = splitRatings(sameTimestamp.reverse());

    expect(splits[0]?.train.map((entry) => entry.movieId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(splits[0]?.test.map((entry) => entry.movieId)).toEqual([9, 10]);
  });

  it(`keeps users with at least ${String(MIN_USER_RATINGS)} mapped ratings and skips the rest`, () => {
    const { splits, stats } = splitRatings([...ratingsFor(2, 9), ...ratingsFor(1, 10)]);

    expect(splits.map((split) => split.userId)).toEqual([1]);
    expect(stats).toEqual({
      users: 2,
      eligibleUsers: 1,
      skippedUsers: 1,
      trainRatings: 8,
      testRatings: 2,
    });
  });

  it('uses 20% of an eligible user’s ratings for testing', () => {
    const { splits, stats } = splitRatings([...ratingsFor(1, 15), ...ratingsFor(2, 10)]);

    expect(splits.map((split) => split.test.length)).toEqual([3, 2]);
    expect(stats.trainRatings).toBe(12 + 8);
    expect(stats.testRatings).toBe(3 + 2);
  });

  it('returns users in ascending id order regardless of input order and leaves the input untouched', () => {
    const input = [...ratingsFor(2, 10), ...ratingsFor(1, 10)];
    const snapshot = input.map((entry) => ({ ...entry }));

    const { splits } = splitRatings(input);

    expect(splits.map((split) => split.userId)).toEqual([1, 2]);
    expect(input).toEqual(snapshot);
  });

  it('returns empty results for empty input', () => {
    expect(splitRatings([])).toEqual({
      splits: [],
      stats: {
        users: 0,
        eligibleUsers: 0,
        skippedUsers: 0,
        trainRatings: 0,
        testRatings: 0,
      },
    });
  });
});
