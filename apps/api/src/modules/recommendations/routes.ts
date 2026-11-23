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
import { createEmbedder, type Embedder } from '../movies/embed.js';
import { combineQueryVector } from './combine.js';
import { parsePromptConstraints } from './constraints.js';
import { recommendMovies } from './recommend.js';

function sendError(response: Response, status: number, body: ApiError): void {
  response.status(status).json(body);
}

export interface RecommendationRateLimit {
  limit: number;
  windowMs: number;
}

export interface RecommendationRouteOptions {
  createEmbedder?: () => Promise<Embedder>;
  rateLimit?: RecommendationRateLimit;
}

const DEFAULT_RATE_LIMIT: RecommendationRateLimit = { limit: 30, windowMs: 60_000 };

interface RateLimitWindow {
  start: number;
  count: number;
}

export function createRecommendationRoutes(
  db: Database,
  options: RecommendationRouteOptions = {},
): Router {
  const router = Router();
  const embedderFactory = options.createEmbedder ?? createEmbedder;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  // Fixed-window counters keyed by client IP; the MVP runs a single API instance.
  const rateLimitWindows = new Map<string, RateLimitWindow>();
  let nextRateLimitSweep = 0;

  // Loading the transformer pipeline is expensive, so it happens on the first prompt request.
  let embedderPromise: Promise<Embedder> | null = null;

  function loadEmbedder(): Promise<Embedder> {
    if (embedderPromise === null) {
      const loading = embedderFactory().catch((error: unknown) => {
        // A transient model-load failure must not brick prompt requests until restart.
        if (embedderPromise === loading) {
          embedderPromise = null;
        }

        throw error;
      });

      embedderPromise = loading;
    }

    return embedderPromise;
  }

  function isRateLimited(clientKey: string, now: number): boolean {
    if (now >= nextRateLimitSweep) {
      for (const [key, window] of rateLimitWindows) {
        if (now - window.start >= rateLimit.windowMs) {
          rateLimitWindows.delete(key);
        }
      }

      nextRateLimitSweep = now + rateLimit.windowMs;
    }

    const window = rateLimitWindows.get(clientKey);

    if (window === undefined || now - window.start >= rateLimit.windowMs) {
      rateLimitWindows.set(clientKey, { start: now, count: 1 });
      return false;
    }

    window.count += 1;

    return window.count > rateLimit.limit;
  }

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

    const { candidateIds, excludeIds, exploration, limit, prompt, tasteVector } = parsed.data;

    // Count before any inference work so over-limit callers never load the model.
    if (isRateLimited(request.ip ?? 'unknown', Date.now())) {
      sendError(response, 429, {
        error: {
          code: 'rate_limited',
          message: 'Too many recommendation requests. Try again later.',
        },
      });
      return;
    }

    let queryVector = tasteVector ?? null;

    if (prompt !== undefined && prompt !== null) {
      const embedder = await loadEmbedder();
      const [promptVector] = await embedder([prompt]);

      if (promptVector === undefined) {
        throw new Error('Embedding model returned no vector for the prompt.');
      }

      queryVector = combineQueryVector({ promptVector, tasteVector: tasteVector ?? null });
    }

    const filters =
      prompt === undefined || prompt === null ? undefined : parsePromptConstraints(prompt);

    const result = await recommendMovies(db, {
      tasteVector: queryVector,
      limit,
      ...(exploration === undefined ? {} : { exploration }),
      ...(filters === undefined ? {} : { filters }),
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
