import { inArray } from 'drizzle-orm';
import { Router, type Response } from 'express';
import {
  recommendationRequestSchema,
  type ApiError,
  type MovieCard,
  type RecommendationResponse,
} from '@movie-recommender/shared';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { toMovieCard } from '../movies/card.js';
import { recommendMovies } from './recommend.js';

function sendError(response: Response, status: number, body: ApiError): void {
  response.status(status).json(body);
}

export function createRecommendationRoutes(db: Database): Router {
  const router = Router();

  router.post('/', async (request, response) => {
    const parsed = recommendationRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      sendError(response, 400, {
        error: {
          code: 'invalid_request',
          message: issue?.message ?? 'Invalid recommendation request.',
          details: parsed.error.issues,
        },
      });
      return;
    }

    const { candidateIds, excludeIds, limit, tasteVector } = parsed.data;
    const result = await recommendMovies(db, {
      tasteVector: tasteVector ?? null,
      limit,
      ...(candidateIds === undefined ? {} : { candidateIds }),
      ...(excludeIds === undefined ? {} : { excludeIds }),
    });

    const cards: MovieCard[] = [];

    if (result.movieIds.length > 0) {
      const rows = await db.select().from(movies).where(inArray(movies.id, result.movieIds));
      const cardsById = new Map(rows.map((row) => [row.id, toMovieCard(row)]));

      for (const movieId of result.movieIds) {
        const card = cardsById.get(movieId);

        if (card !== undefined) {
          cards.push(card);
        }
      }
    }

    const body: RecommendationResponse = { movies: cards, coldStart: result.coldStart };
    response.json(body);
  });

  return router;
}
