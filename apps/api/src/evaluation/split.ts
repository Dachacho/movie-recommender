import type { MappedRating } from './load.js';

/** Users need at least this many catalog-mapped ratings to enter the evaluation. */
export const MIN_USER_RATINGS = 10;

/** Share of each user's newest ratings held out for testing. */
export const TEST_FRACTION = 0.2;

export interface UserSplit {
  userId: number;
  train: MappedRating[];
  test: MappedRating[];
}

export interface SplitStats {
  users: number;
  eligibleUsers: number;
  skippedUsers: number;
  trainRatings: number;
  testRatings: number;
}

function compareByTimestamp(left: MappedRating, right: MappedRating): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  return left.movieId - right.movieId;
}

/**
 * Deterministic per-user split: order each eligible user's mapped ratings by
 * timestamp (movie id breaks ties), keep the oldest 80% as train and the newest
 * 20% as test. Users with fewer than MIN_USER_RATINGS ratings are skipped.
 */
export function splitRatings(ratings: readonly MappedRating[]): {
  splits: UserSplit[];
  stats: SplitStats;
} {
  const byUser = new Map<number, MappedRating[]>();

  for (const rating of ratings) {
    const existing = byUser.get(rating.userId);

    if (existing === undefined) {
      byUser.set(rating.userId, [rating]);
    } else {
      existing.push(rating);
    }
  }

  const splits: UserSplit[] = [];
  let trainRatings = 0;
  let testRatings = 0;

  for (const userId of [...byUser.keys()].sort((left, right) => left - right)) {
    const userRatings = byUser.get(userId);

    if (userRatings === undefined || userRatings.length < MIN_USER_RATINGS) {
      continue;
    }

    const ordered = [...userRatings].sort(compareByTimestamp);
    const testCount = Math.floor(ordered.length * TEST_FRACTION);
    const trainCount = ordered.length - testCount;
    const train = ordered.slice(0, trainCount);
    const test = ordered.slice(trainCount);

    splits.push({ userId, train, test });
    trainRatings += train.length;
    testRatings += test.length;
  }

  return {
    splits,
    stats: {
      users: byUser.size,
      eligibleUsers: splits.length,
      skippedUsers: byUser.size - splits.length,
      trainRatings,
      testRatings,
    },
  };
}
