import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from './load.js';
import { rankByGenre, rankByPopularity, topLikedGenres } from './rank.js';

function entry(movieId: number, voteCount: number | null, genres: string[]): CatalogEntry {
  return { movieId, voteCount, genres };
}

const UNIVERSE: readonly CatalogEntry[] = [
  entry(1, 100, ['Drama']),
  entry(2, 500, ['Comedy']),
  entry(3, null, ['Drama', 'Comedy']),
  entry(4, 500, ['Action']),
  entry(5, 0, ['Drama']),
  entry(6, null, ['Action']),
];

describe('rankByPopularity', () => {
  it('orders by vote count descending and breaks ties by movie id', () => {
    expect(rankByPopularity(UNIVERSE, 10)).toEqual([2, 4, 1, 5, 3, 6]);
  });

  it('puts films without a vote count last', () => {
    expect(rankByPopularity(UNIVERSE, 10).slice(-2)).toEqual([3, 6]);
  });

  it('respects the limit', () => {
    expect(rankByPopularity(UNIVERSE, 2)).toEqual([2, 4]);
  });

  it('is independent of input order', () => {
    expect(rankByPopularity([...UNIVERSE].reverse(), 10)).toEqual(rankByPopularity(UNIVERSE, 10));
  });

  it('rejects an invalid limit', () => {
    expect(() => rankByPopularity(UNIVERSE, 0)).toThrow(RangeError);
    expect(() => rankByPopularity(UNIVERSE, 1.5)).toThrow(RangeError);
  });
});

describe('topLikedGenres', () => {
  it('counts genres across liked films and breaks ties alphabetically', () => {
    const liked = [
      entry(1, 0, ['Drama']),
      entry(2, 0, ['Drama', 'Comedy']),
      entry(3, 0, ['Comedy']),
      entry(4, 0, ['Action']),
      entry(5, 0, ['Drama', 'Action']),
    ];

    expect(topLikedGenres(liked)).toEqual(['Drama', 'Action', 'Comedy']);
  });

  it('respects the profile size', () => {
    expect(topLikedGenres([entry(1, 0, ['Drama', 'Comedy', 'Action', 'Horror'])], 2)).toEqual([
      'Action',
      'Comedy',
    ]);
  });

  it('returns an empty profile when there are no likes', () => {
    expect(topLikedGenres([])).toEqual([]);
  });

  it('rejects an invalid profile size', () => {
    expect(() => topLikedGenres([], 0)).toThrow(RangeError);
  });
});

describe('rankByGenre', () => {
  it('orders by shared genres, then movie id', () => {
    expect(rankByGenre(UNIVERSE, ['Drama', 'Comedy'], 10)).toEqual([3, 1, 2, 5, 4, 6]);
  });

  it('falls back to id order when the profile is empty', () => {
    expect(rankByGenre(UNIVERSE, [], 10)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('respects the limit', () => {
    expect(rankByGenre(UNIVERSE, ['Drama'], 2)).toEqual([1, 3]);
  });

  it('is independent of input order', () => {
    expect(rankByGenre([...UNIVERSE].reverse(), ['Drama'], 10)).toEqual(
      rankByGenre(UNIVERSE, ['Drama'], 10),
    );
  });

  it('rejects an invalid limit', () => {
    expect(() => rankByGenre(UNIVERSE, ['Drama'], 0)).toThrow(RangeError);
  });
});
