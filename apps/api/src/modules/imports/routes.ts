import { sql } from 'drizzle-orm';
import { Router, type Response } from 'express';
import {
  letterboxdImportRequestSchema,
  type ApiError,
  type LetterboxdImportResponse,
} from '@movie-recommender/shared';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import {
  LetterboxdCsvError,
  indexCatalogCandidates,
  matchLetterboxdRows,
  parseLetterboxdCsv,
  type CatalogCandidateIndex,
  type LetterboxdRow,
  type ParsedLetterboxdCsv,
} from './match.js';

function sendError(response: Response, status: number, body: ApiError): void {
  response.status(status).json(body);
}

export interface ImportRateLimit {
  limit: number;
  windowMs: number;
}

export interface ImportRouteOptions {
  rateLimit?: ImportRateLimit;
}

const DEFAULT_RATE_LIMIT: ImportRateLimit = { limit: 10, windowMs: 60_000 };

interface RateLimitWindow {
  start: number;
  count: number;
}

/**
 * One bulk read per import. Each distinct first title token becomes a LIKE
 * pattern, so the query returns a superset of the rows whose normalized title
 * can match; the pure index decides the actual matches. `%` and `_` cannot
 * appear because tokens are letters and digits only.
 */
async function loadCatalogCandidates(
  db: Database,
  rows: readonly LetterboxdRow[],
): Promise<CatalogCandidateIndex> {
  const firstTokens = new Set<string>();

  for (const row of rows) {
    const token = row.normalizedTitle.split(' ')[0];

    if (token !== undefined && token.length > 0) {
      firstTokens.add(token);
    }
  }

  if (firstTokens.size === 0) {
    return new Map();
  }

  const patterns = [...firstTokens].map((token) => `%${token}%`);
  const candidates = await db
    .select({
      movieId: movies.id,
      title: movies.title,
      releaseYear: movies.releaseYear,
    })
    .from(movies)
    .where(sql`lower(${movies.title}) LIKE ANY(${sql.param(patterns)}::text[])`);

  return indexCatalogCandidates(candidates);
}

export function createImportRoutes(db: Database, options: ImportRouteOptions = {}): Router {
  const router = Router();
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  // Fixed-window counters keyed by client IP; the MVP runs a single API instance.
  const rateLimitWindows = new Map<string, RateLimitWindow>();
  let nextRateLimitSweep = 0;

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

  router.post('/letterboxd', async (request, response) => {
    const parsed = letterboxdImportRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];

      sendError(response, 400, {
        error: {
          code: 'invalid_request',
          message: issue?.message ?? 'Invalid Letterboxd import request.',
          details: parsed.error.issues,
        },
      });
      return;
    }

    // Count before parsing so over-limit callers never consume CSV work.
    if (isRateLimited(request.ip ?? 'unknown', Date.now())) {
      sendError(response, 429, {
        error: {
          code: 'rate_limited',
          message: 'Too many import requests. Try again later.',
        },
      });
      return;
    }

    let parsedCsv: ParsedLetterboxdCsv;

    try {
      parsedCsv = parseLetterboxdCsv(parsed.data.csv);
    } catch (error) {
      if (error instanceof LetterboxdCsvError) {
        sendError(response, 400, {
          error: { code: 'invalid_csv', message: error.message },
        });
        return;
      }

      throw error;
    }

    const index = await loadCatalogCandidates(db, parsedCsv.rows);
    const report = matchLetterboxdRows(parsedCsv.rows, index);

    const body: LetterboxdImportResponse = {
      matched: report.matched,
      unmatched: report.unmatched,
      stats: {
        // Raw data rows, including invalid and duplicate rows.
        rows: parsedCsv.rows.length + parsedCsv.invalid,
        matched: report.matched.length,
        unmatched: report.unmatched.length,
        invalid: parsedCsv.invalid,
      },
    };

    response.json(body);
  });

  return router;
}
