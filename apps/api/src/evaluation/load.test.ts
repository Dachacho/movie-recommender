import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../db/client.js';
import { movies } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import type { RawRating } from './load.js';
import {
  loadCatalogIds,
  loadCatalogUniverse,
  loadMovieEmbeddings,
  mapRatings,
  parseLinks,
  parseRatings,
} from './load.js';

async function* csv(text: string): AsyncGenerator<Buffer> {
  yield Buffer.from(text);
}

function rawRating(
  userId: number,
  movieLensMovieId: number,
  rating: number,
  timestamp: number,
): RawRating {
  return { userId, movieLensMovieId, rating, timestamp };
}

describe('parseLinks', () => {
  it('maps MovieLens ids to TMDB ids and reports invalid and duplicate rows', async () => {
    const result = await parseLinks(
      csv(
        [
          'movieId,imdbId,tmdbId',
          '1,0114709,862',
          '2,0113497,8844',
          '3,,0',
          '1,0113497,999',
          'bad,1,2',
          '',
        ].join('\n'),
      ),
    );

    expect([...result.links]).toEqual([
      [1, 862],
      [2, 8844],
    ]);
    expect(result.stats).toEqual({ rows: 5, valid: 2, invalid: 2, duplicates: 1 });
  });

  it('rejects a CSV without the required columns', async () => {
    await expect(parseLinks(csv('movieId,imdbId\n1,2\n'))).rejects.toThrow(
      /missing required columns/,
    );
  });

  it('rejects an empty CSV', async () => {
    await expect(parseLinks(csv(''))).rejects.toThrow(/empty/);
  });
});

describe('parseRatings', () => {
  it('keeps valid ratings and counts malformed rows', async () => {
    const result = await parseRatings(
      csv(
        [
          'userId,movieId,rating,timestamp',
          '1,31,2.5,1260759144',
          '1,32,4,1260759200',
          '2,33,6,1',
          '3,34,3.3,1',
          '4,35,4,1.5',
          '5,36,4,1',
          '',
        ].join('\n'),
      ),
    );

    expect(result.ratings).toEqual([
      rawRating(1, 31, 2.5, 1260759144),
      rawRating(1, 32, 4, 1260759200),
      rawRating(5, 36, 4, 1),
    ]);
    expect(result.stats).toEqual({ rows: 6, invalid: 3 });
  });

  it('rejects a CSV without the required columns', async () => {
    await expect(parseRatings(csv('userId,movieId\n1,2\n'))).rejects.toThrow(
      /missing required columns/,
    );
  });
});

describe('mapRatings', () => {
  it('maps to catalog TMDB ids, dropping unmapped, missing and duplicate ratings', () => {
    const links = new Map([
      [10, 1_000],
      [11, 2_000],
      [12, 3_000],
    ]);
    const catalogIds = new Set([1_000, 2_000]);
    const result = mapRatings(
      links,
      [
        rawRating(1, 10, 5, 1),
        rawRating(1, 10, 4, 2),
        rawRating(1, 11, 4, 3),
        rawRating(2, 12, 4, 4),
        rawRating(3, 99, 4, 5),
      ],
      catalogIds,
    );

    expect(result.ratings).toEqual([
      { userId: 1, movieId: 1_000, rating: 5, timestamp: 1 },
      { userId: 1, movieId: 2_000, rating: 4, timestamp: 3 },
    ]);
    expect(result.stats).toEqual({
      unmapped: 1,
      missingFromCatalog: 1,
      duplicates: 1,
      kept: 2,
    });
  });
});

const FIXTURE_IDS = [992_000_001, 992_000_002];
const connectionString = process.env.DATABASE_URL;

function unitEmbedding(): number[] {
  return [1, ...new Array<number>(383).fill(0)];
}

describe.skipIf(!connectionString)('catalog loaders', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(connectionString));

    await db.delete(movies).where(inArray(movies.id, FIXTURE_IDS));
    await db.insert(movies).values([
      {
        id: FIXTURE_IDS[0]!,
        title: 'Evaluation fixture with embedding',
        genres: ['Drama'],
        voteCount: 10,
        embedding: unitEmbedding(),
        embeddingVersion: 'evaluation-test',
      },
      {
        id: FIXTURE_IDS[1]!,
        title: 'Evaluation fixture without embedding',
        genres: ['Comedy'],
        voteCount: 20,
        embedding: null,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(movies).where(inArray(movies.id, FIXTURE_IDS));
    await pool.end();
  });

  it('loads the catalog id set', async () => {
    const ids = await loadCatalogIds(db);

    expect(ids.has(FIXTURE_IDS[0]!)).toBe(true);
    expect(ids.has(FIXTURE_IDS[1]!)).toBe(true);
  });

  it('loads only films with embeddings into the eligible universe', async () => {
    const universe = await loadCatalogUniverse(db);

    expect(universe.find((entry) => entry.movieId === FIXTURE_IDS[0])).toEqual({
      movieId: FIXTURE_IDS[0],
      voteCount: 10,
      genres: ['Drama'],
    });
    expect(universe.some((entry) => entry.movieId === FIXTURE_IDS[1])).toBe(false);
  });

  it('loads embeddings for requested ids and omits films without one', async () => {
    const embeddings = await loadMovieEmbeddings(db, FIXTURE_IDS);

    expect([...embeddings.keys()]).toEqual([FIXTURE_IDS[0]]);
    expect(embeddings.get(FIXTURE_IDS[0]!)).toHaveLength(384);
  });

  it('returns an empty map without querying for no ids', async () => {
    const unusedDb = new Proxy({} as Database, {
      get() {
        throw new Error('database must not be queried');
      },
    });

    await expect(loadMovieEmbeddings(unusedDb, [])).resolves.toEqual(new Map());
  });
});
