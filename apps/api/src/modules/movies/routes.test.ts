import { once } from 'node:events';
import type { Server } from 'node:http';
import { and, gte, lte } from 'drizzle-orm';
import express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createMovieRoutes } from './routes.js';

const FIXTURE_MIN_ID = 991_200_001;
const FIXTURE_MAX_ID = 991_200_099;
const FIXTURE_RANGE = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

const LIMIT_FIXTURE_COUNT = 25;

interface Fixture {
  id: number;
  title: string;
  releaseYear: number | null;
  runtime: number | null;
  overview: string | null;
  genres: string[];
  director: string | null;
  cast: string[];
  posterPath: string | null;
  voteAverage: number | null;
  voteCount: number | null;
}

const PRIMARY_FIXTURES: readonly Fixture[] = [
  {
    id: 991_200_001,
    title: 'Zxqv Alpha One',
    releaseYear: 2001,
    runtime: 101,
    overview: 'First fixture overview.',
    genres: ['Drama', 'Comedy'],
    director: 'Ada Director',
    cast: ['Actor One', 'Actor Two'],
    posterPath: '/poster-one.jpg',
    voteAverage: 7.5,
    voteCount: 10,
  },
  {
    id: 991_200_002,
    title: 'zxqv alpha TWO',
    releaseYear: null,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
    voteCount: null,
  },
  {
    id: 991_200_003,
    title: '100% Zxqv Alpha Wolf',
    releaseYear: 1999,
    runtime: 88,
    overview: 'Third fixture overview.',
    genres: ['Horror'],
    director: 'Bea Director',
    cast: ['Actor Three'],
    posterPath: '/poster-three.jpg',
    voteAverage: 6.25,
    voteCount: 10,
  },
];

const LIMIT_FIXTURES: readonly Fixture[] = Array.from(
  { length: LIMIT_FIXTURE_COUNT },
  (_unused, index) => ({
    id: 991_200_011 + index,
    title: `Zxqv Bulk ${String(index + 1).padStart(2, '0')}`,
    releaseYear: 2000 + index,
    runtime: 90 + index,
    overview: `Bulk fixture ${String(index + 1)}.`,
    genres: ['Drama'],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
    voteCount: index + 1,
  }),
);

const FIXTURES: readonly Fixture[] = [...PRIMARY_FIXTURES, ...LIMIT_FIXTURES];

function toInsertValue(fixture: Fixture) {
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
    voteCount: fixture.voteCount,
  };
}

interface MovieListBody {
  movies: Array<{ id: number; title: string }>;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

describe.skipIf(!process.env.DATABASE_URL)('movie routes', () => {
  let pool: Pool;
  let db: Database;
  let server: Server;
  let baseUrl: string;

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`);
  }

  function searchUrl(query: string): string {
    return `/movies/search?${new URLSearchParams({ q: query }).toString()}`;
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(FIXTURE_RANGE);
    await db.insert(movies).values(FIXTURES.map(toInsertValue));

    const app = express();
    app.use('/movies', createMovieRoutes(db));

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

  describe('GET /movies/search', () => {
    it('matches a case-insensitive title substring', async () => {
      const response = await get(searchUrl('XQV ALPHA'));

      expect(response.status).toBe(200);

      const body = (await response.json()) as MovieListBody;

      expect(body.movies.map((movie) => movie.id)).toEqual([991_200_001, 991_200_003, 991_200_002]);
    });

    it('treats % in the query as a literal character', async () => {
      const response = await get(searchUrl('% ZXQV'));

      expect(response.status).toBe(200);

      const body = (await response.json()) as MovieListBody;

      expect(body.movies.map((movie) => movie.id)).toEqual([991_200_003]);
    });

    it('treats _ in the query as a literal character', async () => {
      const response = await get(searchUrl('alpha_one'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ movies: [] });
    });

    it('returns 400 for a query shorter than two characters', async () => {
      const response = await get(searchUrl('a'));

      expect(response.status).toBe(400);

      const body = (await response.json()) as ErrorBody;

      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toEqual(expect.any(String));
      expect(body.error.details).toBeDefined();
    });

    it('returns 400 for a query that is blank after trimming', async () => {
      const response = await get(searchUrl('   '));

      expect(response.status).toBe(400);

      const body = (await response.json()) as ErrorBody;

      expect(body.error.code).toBe('invalid_request');
    });

    it('returns 400 when q is missing', async () => {
      const response = await get('/movies/search');

      expect(response.status).toBe(400);

      const body = (await response.json()) as ErrorBody;

      expect(body.error.code).toBe('invalid_request');
    });

    it('returns 200 with an empty list when nothing matches', async () => {
      const response = await get(searchUrl('zxqv no such title'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ movies: [] });
    });

    it('returns at most 20 movies ordered by vote count', async () => {
      const response = await get(searchUrl('zxqv bulk'));

      expect(response.status).toBe(200);

      const body = (await response.json()) as MovieListBody;

      expect(body.movies).toHaveLength(20);
      expect(body.movies[0]?.id).toBe(991_200_035);
      expect(body.movies[19]?.id).toBe(991_200_016);
    });

    it('orders by vote count descending, nulls last, then id ascending', async () => {
      const response = await get(searchUrl('zxqv alpha'));

      expect(response.status).toBe(200);

      const body = (await response.json()) as MovieListBody;

      expect(body.movies.map((movie) => movie.id)).toEqual([991_200_001, 991_200_003, 991_200_002]);
    });
  });

  describe('GET /movies/:id', () => {
    it('returns the full movie card', async () => {
      const response = await get('/movies/991200001');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        movie: {
          id: 991_200_001,
          title: 'Zxqv Alpha One',
          releaseYear: 2001,
          runtime: 101,
          overview: 'First fixture overview.',
          genres: ['Drama', 'Comedy'],
          director: 'Ada Director',
          cast: ['Actor One', 'Actor Two'],
          posterPath: '/poster-one.jpg',
          voteAverage: 7.5,
        },
      });
    });

    it('maps missing metadata to null and empty arrays', async () => {
      const response = await get('/movies/991200002');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        movie: {
          id: 991_200_002,
          title: 'zxqv alpha TWO',
          releaseYear: null,
          runtime: null,
          overview: null,
          genres: [],
          director: null,
          cast: [],
          posterPath: null,
          voteAverage: null,
        },
      });
    });

    it.each(['abc', '0', '-1', '1.5', '99999999999999999999'])(
      'returns 400 for invalid id %s',
      async (id) => {
        const response = await get(`/movies/${id}`);

        expect(response.status).toBe(400);

        const body = (await response.json()) as ErrorBody;

        expect(body.error.code).toBe('invalid_movie_id');
      },
    );

    it('returns 404 for an unknown id', async () => {
      const response = await get('/movies/991299999');

      expect(response.status).toBe(404);

      const body = (await response.json()) as ErrorBody;

      expect(body.error.code).toBe('movie_not_found');
    });
  });
});
