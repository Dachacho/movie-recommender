import { asc, eq, sql } from 'drizzle-orm';
import { Router, type Response } from 'express';
import {
  movieSearchQuerySchema,
  type ApiError,
  type MovieDetailResponse,
  type MovieListResponse,
} from '@movie-recommender/shared';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { toMovieCard } from './card.js';

const SEARCH_LIMIT = 20;
const MAX_MOVIE_ID = 2_147_483_647;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parseMovieId(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return null;
  }

  const id = Number(value);

  return Number.isSafeInteger(id) && id >= 1 && id <= MAX_MOVIE_ID ? id : null;
}

function sendError(response: Response, status: number, body: ApiError): void {
  response.status(status).json(body);
}

export function createMovieRoutes(db: Database): Router {
  const router = Router();

  router.get('/search', async (request, response) => {
    const parsed = movieSearchQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      sendError(response, 400, {
        error: {
          code: 'invalid_request',
          message: issue?.message ?? 'Invalid search query.',
          details: parsed.error.issues,
        },
      });
      return;
    }

    const pattern = `%${escapeLikePattern(parsed.data.q)}%`;
    const rows = await db
      .select()
      .from(movies)
      .where(sql`${movies.title} ILIKE ${pattern} ESCAPE '\\'`)
      .orderBy(sql`${movies.voteCount} DESC NULLS LAST`, asc(movies.id))
      .limit(SEARCH_LIMIT);

    const body: MovieListResponse = { movies: rows.map(toMovieCard) };
    response.json(body);
  });

  router.get('/:id', async (request, response) => {
    const id = parseMovieId(request.params.id);

    if (id === null) {
      sendError(response, 400, {
        error: {
          code: 'invalid_movie_id',
          message: 'Movie id must be a positive integer.',
        },
      });
      return;
    }

    const [movie] = await db.select().from(movies).where(eq(movies.id, id)).limit(1);

    if (movie === undefined) {
      sendError(response, 404, {
        error: {
          code: 'movie_not_found',
          message: 'Movie not found.',
        },
      });
      return;
    }

    const body: MovieDetailResponse = { movie: toMovieCard(movie) };
    response.json(body);
  });

  return router;
}
