import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, gte, lte } from 'drizzle-orm';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { findColdStartPool, findNearestMovies } from './query.js';
import { EXPECTED_EMBEDDING_DIMENSIONS, MAX_ID_COUNT, MAX_QUERY_LIMIT } from './types.js';

const FIXTURE_MIN_ID = 991_000_001;
const FIXTURE_MAX_ID = 991_000_011;
const NULL_METADATA_ID = 991_000_011;
const fixtureRange = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

interface Fixture {
  id: number;
  runtime: number | null;
  releaseYear: number | null;
  genres: string[];
  components: ReadonlyArray<readonly [number, number]> | null;
}

const FIXTURES: readonly Fixture[] = [
  { id: 991_000_001, runtime: 90, releaseYear: 1990, genres: ['Drama'], components: [[0, 1]] },
  { id: 991_000_002, runtime: 100, releaseYear: 1995, genres: ['Comedy'], components: [[0, 1]] },
  { id: 991_000_003, runtime: 120, releaseYear: 2000, genres: ['Action'], components: [[0, 1]] },
  {
    id: 991_000_004,
    runtime: 150,
    releaseYear: 2005,
    genres: ['Drama'],
    components: [[1, 1]],
  },
  {
    id: 991_000_005,
    runtime: 90,
    releaseYear: 2010,
    genres: ['Comedy'],
    components: [[1, 1]],
  },
  {
    id: 991_000_006,
    runtime: 100,
    releaseYear: 1990,
    genres: ['Action'],
    components: [[2, 1]],
  },
  { id: 991_000_007, runtime: 120, releaseYear: 1995, genres: ['Drama'], components: [[2, 1]] },
  {
    id: 991_000_008,
    runtime: 150,
    releaseYear: 2000,
    genres: ['Comedy'],
    components: [
      [0, 0.6],
      [1, 0.8],
    ],
  },
  {
    id: 991_000_009,
    runtime: 90,
    releaseYear: 2005,
    genres: ['Action'],
    components: [
      [1, 0.6],
      [2, 0.8],
    ],
  },
  { id: 991_000_010, runtime: 100, releaseYear: 2010, genres: ['Drama'], components: null },
  {
    id: NULL_METADATA_ID,
    runtime: null,
    releaseYear: null,
    genres: ['Drama'],
    components: [[0, 1]],
  },
];

function embeddingWithComponents(components: ReadonlyArray<readonly [number, number]>): number[] {
  const embedding = new Array<number>(EXPECTED_EMBEDDING_DIMENSIONS).fill(0);

  for (const [index, value] of components) {
    embedding[index] = value;
  }

  return embedding;
}

const unitEmbedding = embeddingWithComponents([[0, 1]]);
const FIXTURE_IDS = FIXTURES.filter((fixture) => fixture.id !== NULL_METADATA_ID).map(
  (fixture) => fixture.id,
);

function sortedIds(rows: ReadonlyArray<{ movieId: number }>): number[] {
  return rows.map((row) => row.movieId).sort((left, right) => left - right);
}

describe.skipIf(!process.env.DATABASE_URL)('recommendation candidate queries', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(fixtureRange);
    await db.insert(movies).values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: `Recommendation fixture ${String(fixture.id)}`,
        releaseYear: fixture.releaseYear,
        runtime: fixture.runtime,
        genres: fixture.genres,
        embedding: fixture.components === null ? null : embeddingWithComponents(fixture.components),
        embeddingVersion: 'recommendation-query-test',
      })),
    );
  });

  afterAll(async () => {
    await db.delete(movies).where(fixtureRange);
    await pool.end();
  });

  describe('findNearestMovies', () => {
    it('orders by cosine distance and tie-breaks by movie id', async () => {
      const rows = await findNearestMovies(db, {
        embedding: unitEmbedding,
        candidateIds: FIXTURE_IDS,
        limit: 200,
      });

      expect(rows.map((row) => row.movieId)).toEqual([
        991_000_001, 991_000_002, 991_000_003, 991_000_008, 991_000_004, 991_000_005, 991_000_006,
        991_000_007, 991_000_009,
      ]);
      expect(rows[0]?.similarity).toBeCloseTo(1, 6);
      expect(rows[3]?.similarity).toBeCloseTo(0.6, 6);
      expect(rows[0]?.embedding).toHaveLength(EXPECTED_EMBEDDING_DIMENSIONS);
    });

    it('removes excluded ids', async () => {
      const rows = await findNearestMovies(db, {
        embedding: unitEmbedding,
        candidateIds: FIXTURE_IDS,
        excludeIds: [991_000_001],
        limit: 4,
      });

      expect(rows.map((row) => row.movieId)).toEqual([
        991_000_002, 991_000_003, 991_000_008, 991_000_004,
      ]);
    });

    it('restricts results to candidate ids', async () => {
      const rows = await findNearestMovies(db, {
        embedding: unitEmbedding,
        candidateIds: [991_000_004, 991_000_006, 991_000_001],
        limit: 10,
      });

      expect(rows.map((row) => row.movieId)).toEqual([991_000_001, 991_000_004, 991_000_006]);
    });

    it('returns an empty result for an explicitly empty candidate list without querying', async () => {
      const unusedDb = new Proxy({} as Database, {
        get() {
          throw new Error('database must not be queried');
        },
      });

      await expect(
        findNearestMovies(unusedDb, { embedding: unitEmbedding, candidateIds: [], limit: 1 }),
      ).resolves.toEqual([]);
    });

    it('respects the limit', async () => {
      const rows = await findNearestMovies(db, {
        embedding: unitEmbedding,
        candidateIds: FIXTURE_IDS,
        limit: 3,
      });

      expect(rows.map((row) => row.movieId)).toEqual([991_000_001, 991_000_002, 991_000_003]);
    });
  });

  describe('findColdStartPool', () => {
    it('returns eligible fixtures with embeddings in a deterministic order', async () => {
      const first = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        limit: MAX_QUERY_LIMIT,
      });
      const second = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        limit: MAX_QUERY_LIMIT,
      });

      expect(first).toHaveLength(9);
      expect(first.map((row) => row.movieId)).toEqual([
        991_000_008, 991_000_005, 991_000_007, 991_000_009, 991_000_002, 991_000_001, 991_000_006,
        991_000_003, 991_000_004,
      ]);
      expect(first.map((row) => row.movieId)).not.toContain(991_000_010);
      expect(first.map((row) => row.movieId)).toEqual(second.map((row) => row.movieId));
      expect(first[0]).not.toHaveProperty('similarity');

      for (const row of first) {
        expect(row.embedding).toHaveLength(EXPECTED_EMBEDDING_DIMENSIONS);
      }
    });

    it('removes excluded ids', async () => {
      const rows = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        excludeIds: [991_000_001, 991_000_002, 991_000_003],
        limit: MAX_QUERY_LIMIT,
      });

      const ids = sortedIds(rows);

      expect(ids).toHaveLength(6);
      expect(ids).not.toContain(991_000_001);
      expect(ids).not.toContain(991_000_002);
      expect(ids).not.toContain(991_000_003);
    });

    it('restricts results to candidate ids', async () => {
      const rows = await findColdStartPool(db, {
        candidateIds: [991_000_010, 991_000_002, 991_000_005],
        limit: MAX_QUERY_LIMIT,
      });

      expect(sortedIds(rows)).toEqual([991_000_002, 991_000_005]);
    });

    it('returns an empty result for an explicitly empty candidate list without querying', async () => {
      const unusedDb = new Proxy({} as Database, {
        get() {
          throw new Error('database must not be queried');
        },
      });

      await expect(findColdStartPool(unusedDb, { candidateIds: [], limit: 1 })).resolves.toEqual(
        [],
      );
    });

    it('respects the limit', async () => {
      const rows = await findColdStartPool(db, { candidateIds: FIXTURE_IDS, limit: 4 });

      expect(rows).toHaveLength(4);
    });
  });

  describe('filters', () => {
    it('filters by runtime bounds', async () => {
      const atLeast = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { runtimeMin: 120 },
        limit: MAX_QUERY_LIMIT,
      });
      const atMost = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { runtimeMax: 100 },
        limit: MAX_QUERY_LIMIT,
      });
      const exact = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { runtimeMin: 120, runtimeMax: 120 },
        limit: MAX_QUERY_LIMIT,
      });

      expect(sortedIds(atLeast)).toEqual([991_000_003, 991_000_004, 991_000_007, 991_000_008]);
      expect(sortedIds(atMost)).toEqual([
        991_000_001, 991_000_002, 991_000_005, 991_000_006, 991_000_009,
      ]);
      expect(sortedIds(exact)).toEqual([991_000_003, 991_000_007]);
    });

    it('filters by release year bounds', async () => {
      const atLeast = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { yearMin: 2000 },
        limit: MAX_QUERY_LIMIT,
      });
      const atMost = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { yearMax: 1995 },
        limit: MAX_QUERY_LIMIT,
      });

      expect(sortedIds(atLeast)).toEqual([
        991_000_003, 991_000_004, 991_000_005, 991_000_008, 991_000_009,
      ]);
      expect(sortedIds(atMost)).toEqual([991_000_001, 991_000_002, 991_000_006, 991_000_007]);
    });

    it('filters by any genre overlap', async () => {
      const single = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { genres: ['Comedy'] },
        limit: MAX_QUERY_LIMIT,
      });
      const multiple = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { genres: ['Action', 'Comedy'] },
        limit: MAX_QUERY_LIMIT,
      });
      const drama = await findColdStartPool(db, {
        candidateIds: FIXTURE_IDS,
        filters: { genres: ['Drama'] },
        limit: MAX_QUERY_LIMIT,
      });

      expect(sortedIds(single)).toEqual([991_000_002, 991_000_005, 991_000_008]);
      expect(sortedIds(multiple)).toEqual([
        991_000_002, 991_000_003, 991_000_005, 991_000_006, 991_000_008, 991_000_009,
      ]);
      expect(sortedIds(drama)).toEqual([991_000_001, 991_000_004, 991_000_007]);
    });

    it('excludes rows with null runtime or release year when a matching bound is set', async () => {
      const unfiltered = await findColdStartPool(db, {
        candidateIds: [NULL_METADATA_ID],
        limit: 1,
      });
      const runtimeFiltered = await findColdStartPool(db, {
        candidateIds: [NULL_METADATA_ID],
        filters: { runtimeMin: 0 },
        limit: 1,
      });
      const yearFiltered = await findColdStartPool(db, {
        candidateIds: [NULL_METADATA_ID],
        filters: { yearMin: 1870 },
        limit: 1,
      });

      expect(unfiltered.map((row) => row.movieId)).toEqual([NULL_METADATA_ID]);
      expect(runtimeFiltered).toEqual([]);
      expect(yearFiltered).toEqual([]);
    });
  });

  describe('input validation', () => {
    it.each([0, 1.5, 201])('rejects invalid limit %s', async (limit) => {
      await expect(findNearestMovies(db, { embedding: unitEmbedding, limit })).rejects.toThrow(
        /limit/,
      );
      await expect(findColdStartPool(db, { limit })).rejects.toThrow(RangeError);
    });

    it('rejects an embedding with the wrong dimension count', async () => {
      await expect(
        findNearestMovies(db, { embedding: new Array(383).fill(0), limit: 1 }),
      ).rejects.toThrow(/embedding/);
    });

    it('rejects an embedding with non-finite values', async () => {
      const embedding = [...unitEmbedding];
      embedding[7] = Number.POSITIVE_INFINITY;

      await expect(findNearestMovies(db, { embedding, limit: 1 })).rejects.toThrow(/embedding/);
    });

    it('rejects invalid runtime filters', async () => {
      await expect(
        findColdStartPool(db, { filters: { runtimeMin: 120, runtimeMax: 90 }, limit: 1 }),
      ).rejects.toThrow(/runtime/);
      await expect(
        findColdStartPool(db, { filters: { runtimeMin: -1 }, limit: 1 }),
      ).rejects.toThrow(/runtime/);
      await expect(
        findColdStartPool(db, { filters: { runtimeMax: 90.5 }, limit: 1 }),
      ).rejects.toThrow(/runtime/);
    });

    it('rejects invalid release year filters', async () => {
      await expect(findColdStartPool(db, { filters: { yearMin: 1800 }, limit: 1 })).rejects.toThrow(
        /year/,
      );
      await expect(findColdStartPool(db, { filters: { yearMax: 2200 }, limit: 1 })).rejects.toThrow(
        /year/,
      );
      await expect(
        findColdStartPool(db, { filters: { yearMin: 2000, yearMax: 1990 }, limit: 1 }),
      ).rejects.toThrow(/year/);
    });

    it('rejects invalid genres', async () => {
      await expect(findColdStartPool(db, { filters: { genres: [''] }, limit: 1 })).rejects.toThrow(
        /genres/,
      );
      await expect(
        findColdStartPool(db, {
          filters: { genres: new Array(21).fill('Drama') },
          limit: 1,
        }),
      ).rejects.toThrow(/genres/);
    });

    it('rejects invalid ids', async () => {
      await expect(
        findNearestMovies(db, { embedding: unitEmbedding, excludeIds: [0], limit: 1 }),
      ).rejects.toThrow(/excludeIds/);
      await expect(
        findNearestMovies(db, { embedding: unitEmbedding, candidateIds: [1.5], limit: 1 }),
      ).rejects.toThrow(/candidateIds/);
      await expect(
        findColdStartPool(db, {
          excludeIds: new Array<number>(MAX_ID_COUNT + 1).fill(1),
          limit: 1,
        }),
      ).rejects.toThrow(/excludeIds/);
    });

    it('accepts the maximum supported limit and an empty exclude list', async () => {
      const rows = await findNearestMovies(db, {
        embedding: unitEmbedding,
        candidateIds: FIXTURE_IDS,
        excludeIds: [],
        limit: MAX_QUERY_LIMIT,
      });

      expect(rows).toHaveLength(9);
    });
  });
});
