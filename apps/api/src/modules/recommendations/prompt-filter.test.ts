import { inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { computeTasteVector } from '../taste/vector.js';
import { parsePromptConstraints } from './constraints.js';
import { recommendMovies } from './recommend.js';

const PROMPT = 'lighthearted movie i can watch with my girlfriend';

/**
 * Real catalog thrillers used to build the online reproduction taste: a 5-star
 * rating for each. They are committed catalog ids, not a live API call.
 */
const THRILLER_IDS = [274, 807, 1949, 146233, 210577, 242582, 273481];

/**
 * DB-backed because the hard filter is applied in the SQL retrieval path. The
 * core parser regression stays DB-free in `evaluation/prompt-cases.test.ts`;
 * this test is skipped when DATABASE_URL is not set.
 */
describe.skipIf(!process.env.DATABASE_URL)('lighthearted prompt hard filter', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('forces Comedy picks over a deterministic thriller taste', async () => {
    const rows = await db
      .select({ movieId: movies.id, genres: movies.genres, embedding: movies.embedding })
      .from(movies)
      .where(inArray(movies.id, THRILLER_IDS));

    // `IN` queries return rows in arbitrary order and float addition is not
    // associative, so sort by movieId to make the summed taste vector
    // byte-for-byte deterministic.
    rows.sort((left, right) => left.movieId - right.movieId);

    expect(rows).toHaveLength(THRILLER_IDS.length);

    for (const row of rows) {
      expect(row.genres).toContain('Thriller');
    }

    const tasteVector = computeTasteVector(
      rows.map((row) => {
        if (row.embedding === null) {
          throw new Error(`Thriller fixture movieId ${String(row.movieId)} has no embedding.`);
        }

        return { movieId: row.movieId, rating: 5, embedding: row.embedding };
      }),
    );

    expect(tasteVector).not.toBeNull();
    if (tasteVector === null) {
      throw new Error('Expected a non-null thriller taste vector.');
    }

    const filters = parsePromptConstraints(PROMPT);
    expect(filters).toEqual({ genres: ['Comedy'] });
    if (filters === undefined) {
      throw new Error('Expected the lighthearted prompt to produce a Comedy filter.');
    }

    const result = await recommendMovies(db, {
      tasteVector,
      filters,
      limit: 4,
    });

    expect(result.movieIds).toHaveLength(4);

    const picks = await db
      .select({ movieId: movies.id, genres: movies.genres })
      .from(movies)
      .where(inArray(movies.id, result.movieIds));

    expect(picks).toHaveLength(4);

    for (const pick of picks) {
      expect(pick.genres).toContain('Comedy');
    }
  });
});
