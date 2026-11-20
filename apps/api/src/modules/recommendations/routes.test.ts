import { once } from 'node:events';
import type { Server } from 'node:http';
import { and, gte, lte } from 'drizzle-orm';
import express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MovieCard } from '@movie-recommender/shared';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createRecommendationRoutes } from './routes.js';

const FIXTURE_MIN_ID = 991_400_001;
const FIXTURE_MAX_ID = 991_400_099;
const FIXTURE_RANGE = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

const EMBEDDING_DIMENSIONS = 384;

const AXIS_ONE_ID = 991_400_001;
const AXIS_TWO_ID = 991_400_002;
const AXIS_THREE_ID = 991_400_003;
const AXIS_FOUR_ID = 991_400_004;
const UNKNOWN_ID = 991_499_999;

interface Fixture {
  id: number;
  title: string;
  releaseYear: number;
  runtime: number;
  overview: string;
  genres: string[];
  director: string;
  cast: string[];
  posterPath: string;
  voteAverage: number;
  voteCount: number;
  axis: number;
}

const FIXTURES: readonly Fixture[] = [
  {
    id: AXIS_ONE_ID,
    title: 'Recommendation route one',
    releaseYear: 2001,
    runtime: 101,
    overview: 'First recommendation overview.',
    genres: ['Drama', 'Comedy'],
    director: 'Ada Director',
    cast: ['Actor One', 'Actor Two'],
    posterPath: '/recommendation-one.jpg',
    voteAverage: 8.1,
    voteCount: 1_000,
    axis: 0,
  },
  {
    id: AXIS_TWO_ID,
    title: 'Recommendation route two',
    releaseYear: 2002,
    runtime: 102,
    overview: 'Second recommendation overview.',
    genres: ['Comedy'],
    director: 'Bea Director',
    cast: ['Actor Three'],
    posterPath: '/recommendation-two.jpg',
    voteAverage: 7.2,
    voteCount: 800,
    axis: 1,
  },
  {
    id: AXIS_THREE_ID,
    title: 'Recommendation route three',
    releaseYear: 2003,
    runtime: 103,
    overview: 'Third recommendation overview.',
    genres: ['Action'],
    director: 'Cara Director',
    cast: ['Actor Four'],
    posterPath: '/recommendation-three.jpg',
    voteAverage: 6.3,
    voteCount: 600,
    axis: 2,
  },
  {
    id: AXIS_FOUR_ID,
    title: 'Recommendation route four',
    releaseYear: 2004,
    runtime: 104,
    overview: 'Fourth recommendation overview.',
    genres: ['Horror'],
    director: 'Dana Director',
    cast: ['Actor Five'],
    posterPath: '/recommendation-four.jpg',
    voteAverage: 5.4,
    voteCount: 400,
    axis: 3,
  },
];

const FIXTURE_IDS = FIXTURES.map((fixture) => fixture.id);

function axisEmbedding(axis: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  embedding[axis] = 1;

  return embedding;
}

function toMovieCard(fixture: Fixture): MovieCard {
  return {
    id: fixture.id,
    title: fixture.title,
    releaseYear: fixture.releaseYear,
    runtime: fixture.runtime,
    overview: fixture.overview,
    genres: fixture.genres,
    director: fixture.director,
    cast: fixture.cast,
    posterPath: fixture.posterPath,
    voteAverage: fixture.voteAverage,
  };
}

const FIXTURE_CARDS = FIXTURES.map(toMovieCard);

const TASTE_VECTOR = axisEmbedding(0);

interface RecommendationBody {
  movies: MovieCard[];
  coldStart: boolean;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

describe.skipIf(!process.env.DATABASE_URL)('recommendation routes', () => {
  let pool: Pool;
  let db: Database;
  let server: Server;
  let baseUrl: string;

  async function postRecommendations(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function postRawRecommendations(body: string): Promise<Response> {
    return fetch(`${baseUrl}/recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  async function readBody(response: Response): Promise<RecommendationBody> {
    return (await response.json()) as RecommendationBody;
  }

  async function readError(response: Response): Promise<ErrorBody> {
    return (await response.json()) as ErrorBody;
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(FIXTURE_RANGE);
    await db.insert(movies).values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        releaseYear: fixture.releaseYear,
        runtime: fixture.runtime,
        overview: fixture.overview,
        genres: fixture.genres,
        director: fixture.director,
        cast: fixture.cast,
        posterPath: fixture.posterPath,
        voteAverage: fixture.voteAverage,
        voteCount: fixture.voteCount,
        embedding: axisEmbedding(fixture.axis),
        embeddingVersion: 'recommendation-routes-test',
      })),
    );

    const app = express();
    app.use(express.json());
    app.use('/recommendations', createRecommendationRoutes(db));

    server = app.listen(0);
    await once(server, 'listening');

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the test server to bind to a TCP port');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (db !== undefined) {
      await db.delete(movies).where(FIXTURE_RANGE);
    }

    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
    }

    if (pool !== undefined) {
      await pool.end();
    }
  });

  it('returns the nearest fixture first with full cards and coldStart false', async () => {
    const response = await postRecommendations({
      source: 'watchlist',
      candidateIds: FIXTURE_IDS,
      tasteVector: TASTE_VECTOR,
      limit: 4,
    });

    expect(response.status).toBe(200);

    const body = await readBody(response);

    expect(Object.keys(body as unknown as Record<string, unknown>)).toEqual([
      'movies',
      'coldStart',
    ]);
    expect(body.coldStart).toBe(false);
    expect(body.movies).toEqual(FIXTURE_CARDS);
  });

  it('accepts source catalog without candidateIds', async () => {
    const response = await postRecommendations({ source: 'catalog', limit: 2 });

    expect(response.status).toBe(200);

    const body = await readBody(response);

    expect(body.coldStart).toBe(true);
    expect(Array.isArray(body.movies)).toBe(true);
    expect(body.movies.length).toBeLessThanOrEqual(2);
  });

  it.each([
    [
      'watchlist without candidateIds',
      { source: 'watchlist', tasteVector: TASTE_VECTOR, limit: 2 },
    ],
    [
      'watchlist with empty candidateIds',
      { source: 'watchlist', candidateIds: [], tasteVector: TASTE_VECTOR, limit: 2 },
    ],
    ['list without candidateIds', { source: 'list', tasteVector: TASTE_VECTOR, limit: 2 }],
    [
      'list with empty candidateIds',
      { source: 'list', candidateIds: [], tasteVector: TASTE_VECTOR, limit: 2 },
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await postRecommendations(body);

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.message).toEqual(expect.any(String));
    expect(errorBody.error.details).toBeDefined();
  });

  it('rejects candidateIds for source catalog', async () => {
    const response = await postRecommendations({
      source: 'catalog',
      candidateIds: FIXTURE_IDS,
      limit: 2,
    });

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.details).toBeDefined();
  });

  it('applies excludeIds before ranking', async () => {
    const response = await postRecommendations({
      source: 'list',
      candidateIds: FIXTURE_IDS,
      excludeIds: [AXIS_ONE_ID],
      tasteVector: TASTE_VECTOR,
      limit: 4,
    });

    expect(response.status).toBe(200);

    const body = await readBody(response);

    expect(body.coldStart).toBe(false);
    expect(body.movies.map((movie) => movie.id)).toEqual([
      AXIS_TWO_ID,
      AXIS_THREE_ID,
      AXIS_FOUR_ID,
    ]);
  });

  it('returns a deterministic cold start that respects the limit', async () => {
    const request = { source: 'list', candidateIds: FIXTURE_IDS, limit: 3 };
    const first = await postRecommendations(request);
    const second = await postRecommendations(request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = await readBody(first);
    const secondBody = await readBody(second);

    expect(firstBody).toEqual(secondBody);
    expect(firstBody.coldStart).toBe(true);
    expect(firstBody.movies).toHaveLength(3);
    expect(new Set(firstBody.movies.map((movie) => movie.id)).size).toBe(3);

    for (const movie of firstBody.movies) {
      expect(FIXTURE_IDS).toContain(movie.id);
    }
  });

  it.each([
    ['a taste vector that is too short', { tasteVector: new Array<number>(383).fill(0) }],
    [
      'a taste vector with a value above the magnitude limit',
      { tasteVector: [...TASTE_VECTOR].map((value, index) => (index === 0 ? 10.5 : value)) },
    ],
  ])('returns 400 for %s', async (_label, extra) => {
    const response = await postRecommendations({
      source: 'list',
      candidateIds: [AXIS_ONE_ID],
      limit: 1,
      ...extra,
    });

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.details).toBeDefined();
  });

  it('returns 400 for a non-finite taste vector value', async () => {
    const vector = `[1e400,${new Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0).join(',')}]`;
    const body = `{"source":"list","candidateIds":[${String(AXIS_ONE_ID)}],"tasteVector":${vector},"limit":1}`;
    const response = await postRawRecommendations(body);

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.details).toBeDefined();
  });

  it.each([0, 5, 1.5])('returns 400 for invalid limit %s', async (limit) => {
    const response = await postRecommendations({
      source: 'list',
      candidateIds: [AXIS_ONE_ID],
      limit,
    });

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.details).toBeDefined();
  });

  it('returns 400 for an invalid source', async () => {
    const response = await postRecommendations({ source: 'bogus', limit: 1 });

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.details).toBeDefined();
  });

  it('returns an explicit empty result for an empty pool', async () => {
    const withTaste = await postRecommendations({
      source: 'list',
      candidateIds: [UNKNOWN_ID],
      tasteVector: TASTE_VECTOR,
      limit: 4,
    });
    const withoutTaste = await postRecommendations({
      source: 'list',
      candidateIds: [UNKNOWN_ID],
      limit: 4,
    });

    expect(withTaste.status).toBe(200);
    await expect(withTaste.json()).resolves.toEqual({ movies: [], coldStart: false });

    expect(withoutTaste.status).toBe(200);
    await expect(withoutTaste.json()).resolves.toEqual({ movies: [], coldStart: true });
  });

  it('returns movies in engine order rather than id order', async () => {
    const response = await postRecommendations({
      source: 'list',
      candidateIds: FIXTURE_IDS,
      tasteVector: axisEmbedding(2),
      limit: 3,
    });

    expect(response.status).toBe(200);

    const body = await readBody(response);

    expect(body.coldStart).toBe(false);
    expect(body.movies.map((movie) => movie.id)).toEqual([AXIS_THREE_ID, AXIS_ONE_ID, AXIS_TWO_ID]);
  });

  it('returns only the movies and coldStart top-level fields', async () => {
    const response = await postRecommendations({
      source: 'list',
      candidateIds: [AXIS_ONE_ID],
      tasteVector: TASTE_VECTOR,
      limit: 1,
    });

    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(['movies', 'coldStart']);
  });
});
