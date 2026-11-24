import { describe, expect, it } from 'vitest';
import {
  orderPoolByQuality,
  QUALITY_TILT_WEIGHT,
  selectDiverse,
} from '../modules/recommendations/select.js';
import type { ScoredCandidate } from '../modules/recommendations/types.js';
import type { CatalogEntry } from './load.js';
import {
  deepRerank,
  fetchNearestPool,
  rankByGenre,
  rankByPopularity,
  rankCandidates,
  tiltPool,
  topLikedGenres,
} from './rank.js';

function entry(movieId: number, voteCount: number | null, genres: string[]): CatalogEntry {
  return { movieId, voteCount, genres };
}

function candidate(
  movieId: number,
  similarity: number,
  embedding: number[],
  voteAverage: number | null = null,
  voteCount: number | null = null,
): ScoredCandidate {
  return { movieId, similarity, embedding, voteAverage, voteCount };
}

/** Deterministic LCG so the fixture is stable across runs. */
function seeded(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;

    return state / 4_294_967_296;
  };
}

function parityFixture(): ScoredCandidate[] {
  const random = seeded(42);
  const candidates: ScoredCandidate[] = [];

  for (let index = 0; index < 24; index += 1) {
    const embedding = Array.from({ length: 8 }, () => random() * 2 - 1);

    candidates.push({
      movieId: index + 1,
      similarity: 1 - index * 0.01 + random() * 0.005,
      embedding,
      voteAverage: random() * 10,
      voteCount: Math.floor(random() * 1_000_000),
    });
  }

  return candidates;
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

describe('deepRerank', () => {
  it('matches selectDiverse for the production limit and tilt', () => {
    const fixture = parityFixture();
    const production = selectDiverse(fixture, { limit: 4 }).map((pick) => pick.movieId);

    expect(deepRerank(fixture, { limit: 4, tiltWeight: QUALITY_TILT_WEIGHT })).toEqual(production);
  });

  it('keeps the production top four as the head of a deeper ranking', () => {
    const fixture = parityFixture();
    const production = selectDiverse(fixture, { limit: 4 }).map((pick) => pick.movieId);
    const deep = deepRerank(fixture, { limit: 100, tiltWeight: QUALITY_TILT_WEIGHT });

    expect(deep.slice(0, 4)).toEqual(production);
  });

  it('returns every candidate when the requested depth exceeds the pool', () => {
    const fixture = parityFixture();

    expect(deepRerank(fixture, { limit: 100, tiltWeight: 0.12 })).toHaveLength(fixture.length);
  });

  it('ranks by raw similarity when the tilt is zero', () => {
    const pool = [candidate(1, 0.9, [1, 0], 0, 0), candidate(2, 0.8, [0, 1], 10, 1_000_000)];

    expect(deepRerank(pool, { limit: 2, tiltWeight: 0 })).toEqual([1, 2]);
  });

  it('promotes a better-received film when the tilt is large enough', () => {
    const pool = [candidate(1, 0.9, [1, 0], 0, 0), candidate(2, 0.8, [0, 1], 10, 1_000_000)];

    expect(deepRerank(pool, { limit: 2, tiltWeight: 0.25 })).toEqual([2, 1]);
  });

  it('breaks score ties by the lower movie id', () => {
    const pool = [candidate(7, 0.5, [1, 0]), candidate(3, 0.5, [0, 1])];

    expect(deepRerank(pool, { limit: 2, tiltWeight: 0 })).toEqual([3, 7]);
  });

  it('rejects an invalid limit, tilt weight or penalty', () => {
    const pool = [candidate(1, 1, [1, 0])];

    expect(() => deepRerank(pool, { limit: 0, tiltWeight: 0.12 })).toThrow(RangeError);
    expect(() => deepRerank(pool, { limit: 1.5, tiltWeight: 0.12 })).toThrow(RangeError);
    expect(() => deepRerank(pool, { limit: 1, tiltWeight: -0.1 })).toThrow(RangeError);
    expect(() => deepRerank(pool, { limit: 1, tiltWeight: Number.NaN })).toThrow(RangeError);
    expect(() => deepRerank(pool, { limit: 1, tiltWeight: 0.12, penalty: 2 })).toThrow(RangeError);
  });
});

describe('deepRerank scoring modes', () => {
  it('orders a three-candidate pool by the z-score blend', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], 0, null),
      candidate(2, 0.8, [0, 1], 10, null),
      candidate(3, 0.7, [1, 1], 5, null),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'zscore', weight: 0.7 },
      }),
    ).toEqual([2, 3, 1]);
  });

  it('falls back to the z-scored similarity order when the z-score weight is zero', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], 0, null),
      candidate(2, 0.8, [0, 1], 10, null),
      candidate(3, 0.7, [1, 1], 5, null),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'zscore', weight: 0 },
      }),
    ).toEqual([1, 2, 3]);
  });

  it('treats a zero-variance similarity dimension as zero', () => {
    const pool = [
      candidate(1, 0.8, [1, 0], 0, null),
      candidate(2, 0.8, [0, 1], 10, null),
      candidate(3, 0.8, [1, 1], 5, null),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'zscore', weight: 0.7 },
      }),
    ).toEqual([2, 3, 1]);
  });

  it('treats a zero-variance quality dimension as zero', () => {
    const pool = [
      candidate(1, 0.7, [1, 0], 5, null),
      candidate(2, 0.9, [0, 1], 5, null),
      candidate(3, 0.8, [1, 1], 5, null),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'zscore', weight: 0.7 },
      }),
    ).toEqual([2, 3, 1]);
  });

  it('computes reciprocal-rank fusion scores from similarity and popularity ranks', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], null, 10),
      candidate(2, 0.8, [0, 1], null, 5_000),
      candidate(3, 0.7, [1, 1], null, 2_000),
      candidate(4, 0.6, [1, -1], null, 1_000),
    ];

    expect(
      deepRerank(pool, {
        limit: 4,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0.5 },
      }),
    ).toEqual([2, 1, 3, 4]);
  });

  it('reduces fusion to similarity order when the fusion weight is zero', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], 0, 0),
      candidate(2, 0.8, [0, 1], 10, 10_000_000),
      candidate(3, 0.7, [1, 1], 0, 0),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: QUALITY_TILT_WEIGHT,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0 },
      }),
    ).toEqual([1, 2, 3]);

    expect(deepRerank(pool, { limit: 3, tiltWeight: QUALITY_TILT_WEIGHT, penalty: 0 })).toEqual([
      2, 1, 3,
    ]);
  });

  it('changes the fusion order when k changes', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], null, 10),
      candidate(2, 0.8, [0, 1], null, 5_000),
      candidate(3, 0.7, [1, 1], null, 2_000),
      candidate(4, 0.6, [1, -1], null, 1_000),
    ];

    expect(
      deepRerank(pool, {
        limit: 4,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0.5, k: 1 },
      }),
    ).toEqual([1, 2, 3, 4]);
  });

  it('defaults fusion k to 60', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], null, 10),
      candidate(2, 0.8, [0, 1], null, 5_000),
      candidate(3, 0.7, [1, 1], null, 2_000),
      candidate(4, 0.6, [1, -1], null, 1_000),
    ];

    expect(
      deepRerank(pool, {
        limit: 4,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0.5 },
      }),
    ).toEqual(
      deepRerank(pool, {
        limit: 4,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0.5, k: 60 },
      }),
    );
  });

  it('ranks fusion popularity with missing vote counts last', () => {
    const pool = [
      candidate(1, 0.9, [1, 0], null, 100),
      candidate(2, 0.7, [0, 1], null, null),
      candidate(3, 0.8, [1, 1], null, 0),
      candidate(4, 0.6, [1, -1], null, 10),
    ];

    // Null-as-zero would rank film 2 third and return [1, 3, 2, 4], the similarity order.
    expect(
      deepRerank(pool, {
        limit: 4,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 0.5 },
      }),
    ).toEqual([1, 3, 4, 2]);
  });

  it('breaks fusion rank ties by movie id', () => {
    const pool = [
      candidate(2, 0.9, [1, 0], null, 100),
      candidate(1, 0.9, [0, 1], null, 100),
      candidate(3, 0.8, [1, 1], null, 200),
    ];

    expect(
      deepRerank(pool, {
        limit: 3,
        tiltWeight: 0,
        penalty: 0,
        scoring: { mode: 'fusion', weight: 1 },
      }),
    ).toEqual([1, 3, 2]);
  });

  it('rejects invalid z-score and fusion weights and k', () => {
    const pool = [candidate(1, 1, [1, 0])];

    expect(() =>
      deepRerank(pool, {
        limit: 1,
        tiltWeight: 0,
        scoring: { mode: 'zscore', weight: Number.NaN },
      }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, { limit: 1, tiltWeight: 0, scoring: { mode: 'zscore', weight: -0.1 } }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, { limit: 1, tiltWeight: 0, scoring: { mode: 'zscore', weight: 1.1 } }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, {
        limit: 1,
        tiltWeight: 0,
        scoring: { mode: 'fusion', weight: Number.NaN },
      }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, { limit: 1, tiltWeight: 0, scoring: { mode: 'fusion', weight: -0.1 } }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, { limit: 1, tiltWeight: 0, scoring: { mode: 'fusion', weight: 0.5, k: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, {
        limit: 1,
        tiltWeight: 0,
        scoring: { mode: 'fusion', weight: 0.5, k: 1.5 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      deepRerank(pool, {
        limit: 1,
        tiltWeight: 0,
        scoring: { mode: 'fusion', weight: 0.5, k: Number.NaN },
      }),
    ).toThrow(RangeError);
  });

  it('carries the scoring mode through rankCandidates', () => {
    const buffer = [candidate(1, 0.9, [1, 0], 0, null), candidate(2, 0.8, [0, 1], 10, null)];

    expect(
      rankCandidates(buffer, {
        poolSize: 2,
        poolTiltWeight: 0,
        tiltWeight: 0,
        depth: 2,
        scoring: { mode: 'zscore', weight: 0.7 },
      }),
    ).toEqual([2, 1]);
  });
});

describe('tiltPool', () => {
  it('orders by similarity plus the weighted quality score', () => {
    const pool = [candidate(1, 0.9, [1, 0], 0, 0), candidate(2, 0.8, [0, 1], 10, 1_000_000)];

    expect(tiltPool(pool, 0.25).map((entry) => entry.movieId)).toEqual([2, 1]);
    expect(tiltPool(pool, 0).map((entry) => entry.movieId)).toEqual([1, 2]);
  });

  it('breaks ties by movie id and leaves the input untouched', () => {
    const pool = [candidate(2, 0.5, [1, 0]), candidate(1, 0.5, [0, 1])];

    expect(tiltPool(pool, 0.12).map((entry) => entry.movieId)).toEqual([1, 2]);
    expect(pool.map((entry) => entry.movieId)).toEqual([2, 1]);
  });

  it('rejects a negative or non-finite weight', () => {
    expect(() => tiltPool([], -1)).toThrow(RangeError);
    expect(() => tiltPool([], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('tiltPool parity', () => {
  it('matches orderPoolByQuality exactly', () => {
    const pool = [
      candidate(3, 0.8, [1, 0], 8, 5_000),
      candidate(1, 0.9, [0, 1]),
      candidate(2, 0.8, [1, 0], 9, 1_000_000),
      candidate(4, 0.7, [0, 1], 5, 10),
    ];

    for (const weight of [0, 0.12, QUALITY_TILT_WEIGHT, 1]) {
      expect(tiltPool(pool, weight)).toEqual(orderPoolByQuality(pool, weight));
    }
  });
});

describe('rankCandidates', () => {
  it('slices the cosine pool when pool-stage tilt is off', () => {
    const buffer = [candidate(1, 0.9, [1, 0], 0, 0), candidate(2, 0.8, [0, 1], 10, 1_000_000)];

    expect(
      rankCandidates(buffer, {
        poolSize: 1,
        poolTiltWeight: 0,
        tiltWeight: 0.12,
        depth: 100,
      }),
    ).toEqual([1]);
  });

  it('can reach past the pool slice when pool-stage tilt is on', () => {
    const buffer = [candidate(1, 0.95, [1, 0], 0, 0), candidate(2, 0.9, [0, 1], 10, 1_000_000)];
    const settings = {
      poolSize: 1,
      poolTiltWeight: 0.12,
      tiltWeight: 0.12,
      depth: 100,
    };

    expect(rankCandidates(buffer, settings)).toEqual([2]);
  });

  it('caps the ranking at the requested depth', () => {
    const buffer = [
      candidate(1, 0.9, [1, 0]),
      candidate(2, 0.8, [0, 1]),
      candidate(3, 0.7, [1, 1]),
    ];

    expect(
      rankCandidates(buffer, {
        poolSize: 3,
        poolTiltWeight: 0,
        tiltWeight: 0.12,
        depth: 2,
      }),
    ).toHaveLength(2);
  });

  it('rejects an invalid pool size', () => {
    expect(() =>
      rankCandidates([], { poolSize: 0, poolTiltWeight: 0, tiltWeight: 0.12, depth: 100 }),
    ).toThrow(RangeError);
  });
});

describe('fetchNearestPool', () => {
  const unusedDatabase = undefined as never;

  it('rejects an invalid pool size before querying', async () => {
    const embedding = Array.from({ length: 384 }, () => 0);

    await expect(
      fetchNearestPool(unusedDatabase, { embedding, excludeIds: [], size: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      fetchNearestPool(unusedDatabase, { embedding, excludeIds: [], size: 1.5 }),
    ).rejects.toThrow(RangeError);
    await expect(
      fetchNearestPool(unusedDatabase, { embedding, excludeIds: [], size: 501 }),
    ).rejects.toThrow(RangeError);
  });
});
