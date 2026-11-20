import { inArray } from 'drizzle-orm';
import { Router, type Response } from 'express';
import { tasteRequestSchema, type ApiError, type TasteResponse } from '@movie-recommender/shared';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { computeTasteVector, type RatedEmbedding } from './vector.js';

function sendError(response: Response, status: number, body: ApiError): void {
  response.status(status).json(body);
}

export function createTasteRoutes(db: Database): Router {
  const router = Router();

  router.post('/', async (request, response) => {
    const parsed = tasteRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      sendError(response, 400, {
        error: {
          code: 'invalid_request',
          message: issue?.message ?? 'Invalid taste request.',
          details: parsed.error.issues,
        },
      });
      return;
    }

    const requestedIds = parsed.data.ratings.map((entry) => entry.movieId);
    const rows = await db
      .select({ id: movies.id, embedding: movies.embedding })
      .from(movies)
      .where(inArray(movies.id, requestedIds));

    const embeddingsById = new Map<number, number[]>();
    for (const row of rows) {
      if (row.embedding !== null) {
        embeddingsById.set(row.id, row.embedding);
      }
    }

    const missingIds = requestedIds
      .filter((id) => !embeddingsById.has(id))
      .sort((left, right) => left - right);

    if (missingIds.length > 0) {
      sendError(response, 400, {
        error: {
          code: 'unknown_movie_ids',
          message: 'Some movie ids are missing or have no embedding.',
          details: { movieIds: missingIds },
        },
      });
      return;
    }

    const rated: RatedEmbedding[] = parsed.data.ratings.map(({ movieId, rating }) => {
      const embedding = embeddingsById.get(movieId);

      if (embedding === undefined) {
        throw new Error(`Missing embedding for movieId ${movieId}.`);
      }

      return { movieId, rating, embedding };
    });

    const body: TasteResponse = { tasteVector: computeTasteVector(rated) };
    response.json(body);
  });

  return router;
}
