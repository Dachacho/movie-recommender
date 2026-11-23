import { once } from 'node:events';
import type { Server } from 'node:http';
import { and, eq, gte, lte } from 'drizzle-orm';
import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LetterboxdImportResponse } from '@movie-recommender/shared';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createImportRoutes } from './routes.js';

const FIXTURE_MIN_ID = 991_500_001;
const FIXTURE_MAX_ID = 991_500_099;
const FIXTURE_RANGE = and(gte(movies.id, FIXTURE_MIN_ID), lte(movies.id, FIXTURE_MAX_ID));

const MATRIX_ID = 991_500_001;
const HEAT_ID = 991_500_002;
const SPIDER_MAN_ID = 991_500_004;

interface Fixture {
  id: number;
  title: string;
  releaseYear: number | null;
}

const MATRIX_TITLE = 'Zxqv Matrix';
const HEAT_TITLE = 'Zxqv Heat';
const SPIDER_MAN_TITLE = 'Zxqv Spider-Man: No Way Home';

const FIXTURES: readonly Fixture[] = [
  { id: MATRIX_ID, title: MATRIX_TITLE, releaseYear: 1999 },
  { id: HEAT_ID, title: HEAT_TITLE, releaseYear: 1995 },
  // Same prefilter token as HEAT_TITLE but a different normalized title.
  { id: 991_500_003, title: 'Zxqv Heatwave', releaseYear: 1995 },
  { id: SPIDER_MAN_ID, title: SPIDER_MAN_TITLE, releaseYear: 2021 },
  { id: 991_500_005, title: 'Zxqv Unknown Year', releaseYear: null },
];

const RATINGS_HEADER = 'Date,Name,Year,Letterboxd URI,Rating\n';
const WATCHES_HEADER = 'Date,Name,Year,Letterboxd URI\n';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function readError(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

describe.skipIf(!process.env.DATABASE_URL)('import routes', () => {
  let pool: Pool;
  let db: Database;
  let server: Server;
  let baseUrl: string;

  async function postImports(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function readReport(response: Response): Promise<LetterboxdImportResponse> {
    return (await response.json()) as LetterboxdImportResponse;
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));

    await db.delete(movies).where(FIXTURE_RANGE);
    await db.insert(movies).values(
      FIXTURES.map((fixture) => ({
        id: fixture.id,
        title: fixture.title,
        releaseYear: fixture.releaseYear,
        genres: [],
      })),
    );

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use('/imports', createImportRoutes(db));
    app.use(
      '/limited-imports',
      createImportRoutes(db, { rateLimit: { limit: 2, windowMs: 60_000 } }),
    );

    const errorHandler: ErrorRequestHandler = (_error, _request, response, _next) => {
      response.status(500).json({
        error: { code: 'internal_error', message: 'Internal server error.' },
      });
    };
    app.use(errorHandler);

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

  it('returns the matched and unmatched report with exact stats', async () => {
    const csv =
      `${RATINGS_HEADER}` +
      `2026-01-01,"Zxqv Matrix",1999,https://boxd.it/a,4.5\n` +
      `2026-01-02,Zxqv Heat,1995,,3\n` +
      `2026-01-03,Zxqv Spider-Man: No Way Home,2021,,\n` +
      `2026-01-04,Unknown Film,2020,,\n` +
      `2026-01-05,Bad Rating,1999,,3.25\n`;

    const response = await postImports('/imports/letterboxd', { csv });

    expect(response.status).toBe(200);

    const body = await readReport(response);

    expect(Object.keys(body as unknown as Record<string, unknown>)).toEqual([
      'matched',
      'unmatched',
      'stats',
    ]);
    expect(body.matched).toEqual([
      { movieId: MATRIX_ID, title: MATRIX_TITLE, releaseYear: 1999, rating: 4.5 },
      { movieId: HEAT_ID, title: HEAT_TITLE, releaseYear: 1995, rating: 3 },
      {
        movieId: SPIDER_MAN_ID,
        title: SPIDER_MAN_TITLE,
        releaseYear: 2021,
        rating: null,
      },
    ]);
    expect(body.unmatched).toEqual([{ name: 'Unknown Film', year: 2020, reason: 'no_match' }]);
    expect(body.stats).toEqual({ rows: 5, matched: 3, unmatched: 1, invalid: 1 });
  });

  it('matches case, punctuation and a one-year difference without false positives', async () => {
    const csv =
      `${RATINGS_HEADER}` +
      `2026-01-01,"  zxqv  MATRIX ",2000,,5\n` +
      `2026-01-02,ZXQV HEAT,1996,,4\n`;

    const response = await postImports('/imports/letterboxd', { csv });

    expect(response.status).toBe(200);

    const body = await readReport(response);

    expect(body.matched).toEqual([
      { movieId: MATRIX_ID, title: MATRIX_TITLE, releaseYear: 1999, rating: 5 },
      { movieId: HEAT_ID, title: HEAT_TITLE, releaseYear: 1995, rating: 4 },
    ]);
    expect(body.unmatched).toEqual([]);
    expect(body.stats).toEqual({ rows: 2, matched: 2, unmatched: 0, invalid: 0 });
  });

  it('matches a watches export as watched-only with a null rating', async () => {
    const csv = `${WATCHES_HEADER}2026-01-01,Zxqv Heat,1995,https://boxd.it/b\n`;

    const response = await postImports('/imports/letterboxd', { csv });

    expect(response.status).toBe(200);

    const body = await readReport(response);

    expect(body.matched).toEqual([
      { movieId: HEAT_ID, title: HEAT_TITLE, releaseYear: 1995, rating: null },
    ]);
    expect(body.stats).toEqual({ rows: 1, matched: 1, unmatched: 0, invalid: 0 });
  });

  it('lets the last duplicate row win for the same film', async () => {
    const csv =
      `${RATINGS_HEADER}` + `2026-01-01,Zxqv Heat,1995,,2\n` + `2026-01-02,Zxqv Heat,1995,,5\n`;

    const response = await postImports('/imports/letterboxd', { csv });

    expect(response.status).toBe(200);

    const body = await readReport(response);

    expect(body.matched).toEqual([
      { movieId: HEAT_ID, title: HEAT_TITLE, releaseYear: 1995, rating: 5 },
    ]);
    expect(body.stats).toEqual({ rows: 2, matched: 1, unmatched: 0, invalid: 0 });
  });

  it('does not write rows to the catalog', async () => {
    const unmatchedName = 'Zxqv Not In Catalog';
    const response = await postImports('/imports/letterboxd', {
      csv: `${RATINGS_HEADER}2026-01-01,${unmatchedName},1950,,4\n`,
    });

    expect(response.status).toBe(200);

    const inserted = await db
      .select({ id: movies.id })
      .from(movies)
      .where(eq(movies.title, unmatchedName));

    expect(inserted).toEqual([]);
  });

  it('does not match a row with a year to a catalog film without a year', async () => {
    const csv = `${RATINGS_HEADER}2026-01-01,Zxqv Unknown Year,2001,,4\n`;

    const response = await postImports('/imports/letterboxd', { csv });

    expect(response.status).toBe(200);

    const body = await readReport(response);

    expect(body.matched).toEqual([]);
    expect(body.unmatched).toEqual([{ name: 'Zxqv Unknown Year', year: 2001, reason: 'no_match' }]);
  });

  it('returns an explicit empty report for a header-only export', async () => {
    const response = await postImports('/imports/letterboxd', { csv: RATINGS_HEADER });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      matched: [],
      unmatched: [],
      stats: { rows: 0, matched: 0, unmatched: 0, invalid: 0 },
    });
  });

  it('returns 400 invalid_request for an oversized csv string', async () => {
    const response = await postImports('/imports/letterboxd', { csv: 'x'.repeat(200_001) });

    expect(response.status).toBe(400);

    const body = await readError(response);

    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details).toBeDefined();
  });

  it.each([
    ['a missing csv field', {}],
    ['a non-string csv field', { csv: 42 }],
  ])('returns 400 invalid_request for %s', async (_label, body) => {
    const response = await postImports('/imports/letterboxd', body);

    expect(response.status).toBe(400);

    const errorBody = await readError(response);

    expect(errorBody.error.code).toBe('invalid_request');
  });

  it('returns 400 invalid_csv for a missing Name column', async () => {
    const response = await postImports('/imports/letterboxd', {
      csv: 'Date,Year,Rating\n2026-01-01,1995,4\n',
    });

    expect(response.status).toBe(400);

    const body = await readError(response);

    expect(body.error.code).toBe('invalid_csv');
  });

  it('returns 400 invalid_csv for an unterminated quoted field', async () => {
    const response = await postImports('/imports/letterboxd', {
      csv: `${RATINGS_HEADER}2026-01-01,"Zxqv Heat`,
    });

    expect(response.status).toBe(400);

    const body = await readError(response);

    expect(body.error.code).toBe('invalid_csv');
  });

  it('returns 400 invalid_csv above the row cap', async () => {
    const rows = '2026-01-01,Zxqv Heat,1995,\n'.repeat(5_001);

    const response = await postImports('/imports/letterboxd', { csv: `${WATCHES_HEADER}${rows}` });

    expect(response.status).toBe(400);

    const body = await readError(response);

    expect(body.error.code).toBe('invalid_csv');
  });

  it('rate limits imports per client IP with 429 rate_limited', async () => {
    const body = { csv: `${WATCHES_HEADER}2026-01-01,Zxqv Heat,1995,\n` };

    const first = await postImports('/limited-imports/letterboxd', body);
    const second = await postImports('/limited-imports/letterboxd', body);
    const third = await postImports('/limited-imports/letterboxd', body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);

    const errorBody = await readError(third);

    expect(errorBody.error.code).toBe('rate_limited');
  });
});
