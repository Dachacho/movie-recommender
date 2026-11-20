import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, lte } from 'drizzle-orm';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { recommendMovies } from './recommend.js';
import { EXPECTED_EMBEDDING_DIMENSIONS } from './types.js';

const FIXTURE_MIN_ID = 991_100_001;
const FIXTURE_MAX_ID = 991_100_005;
const LOW_VOTE_ID = 991_100_001;
const fixtureRange = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

interface Fixture {
  id: number;
  runtime: number;
  releaseYear: number;
  genres: string[];
  components: ReadonlyArray<readonly [number, number]>;
  voteCount: number;
  popularity: number;
}

const FIXTURES: readonly Fixture[] = [
  {
    id: 991_100_001,
    runtime: 90,
    releaseYear: 1990,
    genres: ['Drama'],
    components: [[0, 1]],
    voteCount: 3,
    popularity: 0.4,
  },
  {
    id: 991_100_002,
    runtime: 120,
    releaseYear: 2000,
    genres: ['Comedy'],
    components: [[1, 1]],
    voteCount: 5_000,
    popularity: 50,
  },
  {
    id: 991_100_003,
    runtime: 150,
    releaseYear: 2010,
    genres: ['Action'],
    components: [[2, 1]],
    voteCount: 1_200,
    popularity: 20,
  },
  {
    id: 991_100_004,
    runtime: 100,
    releaseYear: 1995,
    genres: ['Drama'],
    components: [
      [0, 0.6],
      [1, 0.8],
    ],
    voteCount: 8_000,
    popularity: 80,
  },
  {
    id: 991_100_005,
    runtime: 140,
    releaseYear: 2005,
    genres: ['Comedy'],
    components: [[3, 1]],
    voteCount: 2,
    popularity: 0.5,
  },
];

const FIXTURE_IDS = FIXTURES.map((fixture) => fixture.id);
const TASTE_VECTOR = embeddingWithComponents([[0, 1]]);

function embeddingWithComponents(components: ReadonlyArray<readonly [number, number]>): number[] {
  const embedding = new Array<number>(EXPECTED_EMBEDDING_DIMENSIONS).fill(0);

  for (const [index, value] of components) {
    embedding[index] = value;
  }

  return embedding;
}

function sortedIds(ids: readonly number[]): number[] {
  return [...ids].sort((left, right) => left - right);
}

function throwingDatabase(): Database {
  return new Proxy({} as Database, {
    get() {
      throw new Error('database must not be queried');
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)('recommendMovies', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(fixtureRange);
    await db.insert(movies).values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: `Recommendation engine fixture ${String(fixture.id)}`,
        releaseYear: fixture.releaseYear,
        runtime: fixture.runtime,
        genres: fixture.genres,
        embedding: embeddingWithComponents(fixture.components),
        embeddingVersion: 'recommendation-engine-test',
        voteCount: fixture.voteCount,
        popularity: fixture.popularity,
      })),
    );
  });

  afterAll(async () => {
    await db.delete(movies).where(fixtureRange);
    await pool.end();
  });

  it('returns the nearest fixture first and respects the limit', async () => {
    const result = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      limit: 3,
    });

    expect(result.coldStart).toBe(false);
    expect(result.movieIds).toHaveLength(3);
    expect(result.movieIds[0]).toBe(991_100_001);

    for (const movieId of result.movieIds) {
      expect(FIXTURE_IDS).toContain(movieId);
    }
  });

  it('removes excluded ids', async () => {
    const result = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      excludeIds: [991_100_001],
      limit: 4,
    });

    expect(result.coldStart).toBe(false);
    expect(result.movieIds).toHaveLength(4);
    expect(result.movieIds).not.toContain(991_100_001);
  });

  it('restricts results to the supplied candidate ids', async () => {
    const result = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: [991_100_003, 991_100_004],
      limit: 4,
    });

    expect(sortedIds(result.movieIds)).toEqual([991_100_003, 991_100_004]);
  });

  it('returns an explicit empty result for an empty candidate list', async () => {
    const result = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: [],
      limit: 4,
    });
    const coldStart = await recommendMovies(db, { candidateIds: [], limit: 4 });

    expect(result).toEqual({ movieIds: [], coldStart: false });
    expect(coldStart).toEqual({ movieIds: [], coldStart: true });
  });

  it('applies runtime, year and genre filters through the engine', async () => {
    const runtime = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      filters: { runtimeMin: 120 },
      limit: 4,
    });
    const year = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      filters: { yearMin: 2000, yearMax: 2005 },
      limit: 4,
    });
    const genre = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      filters: { genres: ['Drama'] },
      limit: 4,
    });

    expect(sortedIds(runtime.movieIds)).toEqual([991_100_002, 991_100_003, 991_100_005]);
    expect(sortedIds(year.movieIds)).toEqual([991_100_002, 991_100_005]);
    expect(sortedIds(genre.movieIds)).toEqual([991_100_001, 991_100_004]);
  });

  it('falls back to a deterministic cold start without a taste vector', async () => {
    const first = await recommendMovies(db, { candidateIds: FIXTURE_IDS, limit: 3 });
    const second = await recommendMovies(db, { candidateIds: FIXTURE_IDS, limit: 3 });
    const explicitNull = await recommendMovies(db, {
      tasteVector: null,
      candidateIds: FIXTURE_IDS,
      limit: 3,
    });

    expect(first.coldStart).toBe(true);
    expect(first.movieIds).toHaveLength(3);
    // md5(id::text) orders 991100005 first, so rank-as-relevance must pick it first.
    expect(first.movieIds[0]).toBe(991_100_005);
    expect(first).toEqual(second);
    expect(explicitNull).toEqual(first);
  });

  it('honours exclusions and candidate ids during cold start', async () => {
    const excluded = await recommendMovies(db, {
      candidateIds: FIXTURE_IDS,
      excludeIds: [991_100_001, 991_100_002],
      limit: 4,
    });
    const restricted = await recommendMovies(db, {
      candidateIds: [991_100_003, 991_100_004],
      limit: 4,
    });

    expect(excluded.coldStart).toBe(true);
    expect(sortedIds(excluded.movieIds)).toEqual([991_100_003, 991_100_004, 991_100_005]);
    expect(sortedIds(restricted.movieIds)).toEqual([991_100_003, 991_100_004]);
  });

  it('returns a low-vote fixture when it is the nearest instead of gating on popularity', async () => {
    const [fixture] = await db
      .select({ voteCount: movies.voteCount, popularity: movies.popularity })
      .from(movies)
      .where(eq(movies.id, LOW_VOTE_ID));

    expect(fixture?.voteCount).toBe(3);
    expect(fixture?.popularity).toBeCloseTo(0.4, 5);

    const result = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: [LOW_VOTE_ID],
      limit: 1,
    });

    expect(result).toEqual({ movieIds: [LOW_VOTE_ID], coldStart: false });
  });

  it.each([0, 5, 1.5])('rejects invalid limit %s before any database access', async (limit) => {
    await expect(
      recommendMovies(throwingDatabase(), { tasteVector: TASTE_VECTOR, limit }),
    ).rejects.toThrow(RangeError);
    await expect(
      recommendMovies(throwingDatabase(), { tasteVector: TASTE_VECTOR, limit }),
    ).rejects.toThrow(/limit/);
  });

  it('rejects an invalid taste vector before any database access', async () => {
    const wrongDimensions = new Array<number>(383).fill(0);
    const nonFinite = [...TASTE_VECTOR];
    nonFinite[7] = Number.POSITIVE_INFINITY;

    await expect(
      recommendMovies(throwingDatabase(), { tasteVector: wrongDimensions, limit: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      recommendMovies(throwingDatabase(), { tasteVector: wrongDimensions, limit: 1 }),
    ).rejects.toThrow(/embedding/);
    await expect(
      recommendMovies(throwingDatabase(), { tasteVector: nonFinite, limit: 1 }),
    ).rejects.toThrow(/embedding/);
  });

  it('returns an explicit empty result when the pool is empty', async () => {
    const noTaste = await recommendMovies(db, {
      tasteVector: TASTE_VECTOR,
      candidateIds: FIXTURE_IDS,
      filters: { runtimeMin: 1_000 },
      limit: 4,
    });
    const coldStart = await recommendMovies(db, {
      candidateIds: FIXTURE_IDS,
      filters: { runtimeMin: 1_000 },
      limit: 4,
    });

    expect(noTaste).toEqual({ movieIds: [], coldStart: false });
    expect(coldStart).toEqual({ movieIds: [], coldStart: true });
  });

  it('does not mutate the input object', async () => {
    const input = {
      tasteVector: TASTE_VECTOR,
      filters: { runtimeMin: 90, genres: ['Drama'] },
      excludeIds: [991_100_002],
      candidateIds: [...FIXTURE_IDS],
      limit: 2,
    };
    const snapshot = structuredClone(input);

    await recommendMovies(db, input);

    expect(input).toEqual(snapshot);
  });
});
