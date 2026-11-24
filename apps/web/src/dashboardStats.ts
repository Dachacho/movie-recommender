import type { HistoryEntry } from './profile/schema';

export const RATING_BUCKETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_WINDOW_MS = 7 * DAY_MS;

export function meanRating(ratings: readonly { rating: number }[]): number | null {
  if (ratings.length === 0) {
    return null;
  }

  let total = 0;

  for (const { rating } of ratings) {
    total += rating;
  }

  return total / ratings.length;
}

export function ratingHistogram(
  ratings: readonly { rating: number }[],
): { rating: number; count: number }[] {
  const counts = new Map<number, number>();

  for (const bucket of RATING_BUCKETS) {
    counts.set(bucket, 0);
  }

  for (const { rating } of ratings) {
    const count = counts.get(rating);

    if (count !== undefined) {
      counts.set(rating, count + 1);
    }
  }

  return RATING_BUCKETS.map((rating) => ({ rating, count: counts.get(rating) ?? 0 }));
}

export function recentActivity(
  history: readonly HistoryEntry[],
  now: number,
  windowMs = DEFAULT_ACTIVITY_WINDOW_MS,
): { rounds: number; replacements: number } {
  const cutoff = now - windowMs;
  let rounds = 0;
  let replacements = 0;

  for (const entry of history) {
    if (entry.createdAt > cutoff) {
      rounds += 1;

      if (entry.kind === 'replace') {
        replacements += 1;
      }
    }
  }

  return { rounds, replacements };
}

export function formatRating(rating: number): string {
  if (rating % 1 === 0.5) {
    return `${Math.floor(rating)}½`;
  }

  return `${rating}`;
}
