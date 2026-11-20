import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Database } from './db/client.js';
import { createMovieRoutes } from './modules/movies/routes.js';
import { createRecommendationRoutes } from './modules/recommendations/routes.js';
import { createTasteRoutes } from './modules/taste/routes.js';

function bodyParserErrorType(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    return (error as { type?: unknown }).type;
  }

  return undefined;
}

export function createApp({ db }: { db: Database }): Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use('/movies', createMovieRoutes(db));
  app.use('/taste', createTasteRoutes(db));
  app.use('/recommendations', createRecommendationRoutes(db));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const type = bodyParserErrorType(error);

    if (type === 'entity.parse.failed') {
      response.status(400).json({
        error: { code: 'invalid_json', message: 'Request body must be valid JSON.' },
      });
      return;
    }

    if (type === 'entity.too.large') {
      response.status(413).json({
        error: { code: 'payload_too_large', message: 'Request body is too large.' },
      });
      return;
    }

    response.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error.' },
    });
  });

  return app;
}
