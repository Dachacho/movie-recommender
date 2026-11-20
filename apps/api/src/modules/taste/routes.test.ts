import { once } from 'node:events';
import type { Server } from 'node:http';
import { and, gte, lte } from 'drizzle-orm';
import express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createTasteRoutes } from './routes.js';

const FIXTURE_MIN_ID = 991_300_001;
const FIXTURE_MAX_ID = 991_300_099;
const FIXTURE_RANGE = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

const EMBEDDING_DIMENSIONS = 384;

const AXIS_ONE_ID = 991_300_001;
const AXIS_TWO_ID = 991_300_002;
const AXIS_THREE_ID = 991_300_003;
const NULL_EMBEDDING_ID = 991_300_004;
const UNKNOWN_ID = 991_399_999;

function axisEmbedding(axis: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  embedding[axis] = 1;

  return embedding;
}

const FIXTURES = [
  { id: AXIS_ONE_ID, title: 'Taste axis one', embedding: axisEmbedding(0) },
  { id: AXIS_TWO_ID, title: 'Taste axis two', embedding: axisEmbedding(1) },
  { id: AXIS_THREE_ID, title: 'Taste axis three', embedding: axisEmbedding(2) },
  { id: NULL_EMBEDDING_ID, title: 'Taste null embedding', embedding: null },
];

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface SuccessBody {
  tasteVector: number[] | null;
}

function expectUnitVector(body: unknown, axis: number): void {
  expect(Object.keys(body as Record<string, unknown>)).toEqual(['tasteVector']);

  const vector = (body as SuccessBody).tasteVector;
  expect(vector).not.toBeNull();
  expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);

  const values = vector ?? [];
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
    expect(values[index]).toBeCloseTo(index === axis ? 1 : 0, 12);
  }
}

describe.skipIf(!process.env.DATABASE_URL)('taste routes', () => {
  let pool: Pool;
  let db: Database;
  let server: Server;
  let baseUrl: string;

  async function postTaste(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/taste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(FIXTURE_RANGE);
    await db.insert(movies).values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        embedding: fixture.embedding,
        embeddingVersion: 'taste-routes-test',
      })),
    );

    const app = express();
    app.use(express.json());
    app.use('/taste', createTasteRoutes(db));

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

  it('returns the unit embedding for a single five-star rating', async () => {
    const response = await postTaste({ ratings: [{ movieId: AXIS_ONE_ID, rating: 5 }] });

    expect(response.status).toBe(200);
    expectUnitVector(await response.json(), 0);
  });

  it('sums weighted embeddings and normalizes the result', async () => {
    const response = await postTaste({
      ratings: [
        { movieId: AXIS_ONE_ID, rating: 4.5 },
        { movieId: AXIS_TWO_ID, rating: 1.5 },
      ],
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as SuccessBody;
    expect(Object.keys(body)).toEqual(['tasteVector']);
    expect(body.tasteVector).toHaveLength(EMBEDDING_DIMENSIONS);

    const values = body.tasteVector ?? [];
    const expected = [2 / Math.sqrt(5), -1 / Math.sqrt(5), 0];
    for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) {
      expect(values[index]).toBeCloseTo(expected[index] ?? 0, 12);
    }
  });

  it('returns a null taste vector for a baseline rating', async () => {
    const response = await postTaste({ ratings: [{ movieId: AXIS_THREE_ID, rating: 2.5 }] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tasteVector: null });
  });

  it('returns 400 with the unknown movie id', async () => {
    const response = await postTaste({ ratings: [{ movieId: UNKNOWN_ID, rating: 5 }] });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('unknown_movie_ids');
    expect(body.error.details).toEqual({ movieIds: [UNKNOWN_ID] });
  });

  it('returns 400 when a requested movie has a null embedding', async () => {
    const response = await postTaste({ ratings: [{ movieId: NULL_EMBEDDING_ID, rating: 5 }] });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('unknown_movie_ids');
    expect(body.error.details).toEqual({ movieIds: [NULL_EMBEDDING_ID] });
  });

  it('returns sorted missing ids for mixed unknown and null-embedding movies', async () => {
    const response = await postTaste({
      ratings: [
        { movieId: UNKNOWN_ID, rating: 5 },
        { movieId: AXIS_ONE_ID, rating: 5 },
        { movieId: NULL_EMBEDDING_ID, rating: 5 },
        { movieId: UNKNOWN_ID - 1, rating: 5 },
      ],
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('unknown_movie_ids');
    expect(body.error.details).toEqual({
      movieIds: [NULL_EMBEDDING_ID, UNKNOWN_ID - 1, UNKNOWN_ID],
    });
  });

  it.each([
    ['empty ratings', { ratings: [] }],
    ['rating 0', { ratings: [{ movieId: AXIS_ONE_ID, rating: 0 }] }],
    ['rating 5.5', { ratings: [{ movieId: AXIS_ONE_ID, rating: 5.5 }] }],
    ['rating 2.7', { ratings: [{ movieId: AXIS_ONE_ID, rating: 2.7 }] }],
    ['movieId above int4', { ratings: [{ movieId: 3_000_000_000, rating: 5 }] }],
    ['missing ratings field', {}],
    [
      'duplicate movie ids',
      {
        ratings: [
          { movieId: AXIS_ONE_ID, rating: 5 },
          { movieId: AXIS_ONE_ID, rating: 4 },
        ],
      },
    ],
    [
      'more than 500 ratings',
      {
        ratings: Array.from({ length: 501 }, (_unused, index) => ({
          movieId: index + 1,
          rating: 5,
        })),
      },
    ],
  ])('returns 400 invalid_request for %s', async (_label, body) => {
    const response = await postTaste(body);

    expect(response.status).toBe(400);

    const errorBody = (await response.json()) as ErrorBody;
    expect(errorBody.error.code).toBe('invalid_request');
    expect(errorBody.error.message).toEqual(expect.any(String));
    expect(errorBody.error.details).toBeDefined();
  });
});
