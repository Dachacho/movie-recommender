import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './profile/schema';
import { formatRating, meanRating, ratingHistogram, recentActivity } from './dashboardStats';

const ZERO_HISTOGRAM = [
  { rating: 0.5, count: 0 },
  { rating: 1, count: 0 },
  { rating: 1.5, count: 0 },
  { rating: 2, count: 0 },
  { rating: 2.5, count: 0 },
  { rating: 3, count: 0 },
  { rating: 3.5, count: 0 },
  { rating: 4, count: 0 },
  { rating: 4.5, count: 0 },
  { rating: 5, count: 0 },
];

function historyEntry(
  id: number,
  createdAt: number,
  kind: HistoryEntry['kind'] = 'round',
): HistoryEntry {
  return {
    id,
    createdAt,
    kind,
    source: 'catalog',
    prompt: '',
    replacedMovieId: null,
    movies: [{ id: 100 + id, title: `Movie ${id}`, releaseYear: 2000, posterPath: null }],
  };
}

describe('meanRating', () => {
  it('returns null for no ratings', () => {
    expect(meanRating([])).toBeNull();
  });

  it('returns a single rating unchanged', () => {
    expect(meanRating([{ rating: 4.5 }])).toBe(4.5);
  });

  it('averages all given ratings', () => {
    expect(meanRating([{ rating: 4 }, { rating: 3 }])).toBe(3.5);
  });

  it('counts duplicate ratings separately', () => {
    expect(meanRating([{ rating: 4 }, { rating: 4 }, { rating: 2 }])).toBeCloseTo(10 / 3, 10);
  });
});

describe('formatRating', () => {
  it.each([
    [0.5, '½'],
    [3, '3'],
    [4.5, '4½'],
    [5, '5'],
  ] as const)('formats %s as %s', (rating, expected) => {
    expect(formatRating(rating)).toBe(expected);
  });
});

describe('ratingHistogram', () => {
  it('returns all ten buckets in half-star order with zero counts for no ratings', () => {
    expect(ratingHistogram([])).toEqual(ZERO_HISTOGRAM);
  });

  it('counts duplicate ratings in their bucket', () => {
    const histogram = ratingHistogram([
      { rating: 4.5 },
      { rating: 4.5 },
      { rating: 3 },
      { rating: 3 },
      { rating: 3 },
    ]);

    expect(histogram.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 0, 3, 0, 0, 2, 0]);
  });

  it('ignores ratings that are not one of the buckets', () => {
    expect(ratingHistogram([{ rating: 4.2 }, { rating: 0 }, { rating: 5.5 }])).toEqual(
      ZERO_HISTOGRAM,
    );
  });
});

describe('recentActivity', () => {
  const NOW = 1_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('returns zero counts for no history', () => {
    expect(recentActivity([], NOW)).toEqual({ rounds: 0, replacements: 0 });
  });

  it('counts entries inside the default seven-day window and excludes the boundary', () => {
    const history = [
      historyEntry(1, NOW - 7 * DAY_MS + 1),
      historyEntry(2, NOW - 7 * DAY_MS),
      historyEntry(3, NOW - 7 * DAY_MS - 1),
      historyEntry(4, NOW),
    ];

    expect(recentActivity(history, NOW)).toEqual({ rounds: 2, replacements: 0 });
  });

  it('counts replacements separately from other rounds', () => {
    const history = [
      historyEntry(1, NOW - DAY_MS, 'round'),
      historyEntry(2, NOW - DAY_MS, 'replace'),
      historyEntry(3, NOW - DAY_MS, 'refresh'),
      historyEntry(4, NOW - 8 * DAY_MS, 'replace'),
    ];

    expect(recentActivity(history, NOW)).toEqual({ rounds: 3, replacements: 1 });
  });

  it('honours an explicit window', () => {
    const history = [historyEntry(1, NOW - 999), historyEntry(2, NOW - 1000)];

    expect(recentActivity(history, NOW, 1000)).toEqual({ rounds: 1, replacements: 0 });
  });
});
