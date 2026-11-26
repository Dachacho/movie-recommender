import { inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createEmbedder, type Embedder } from '../movies/embed.js';
import { computeTasteVector } from '../taste/vector.js';
import { combineQueryVector } from './combine.js';
import { parsePromptConstraints } from './constraints.js';
import { parsePromptMood } from './mood.js';
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
  let embedder: Embedder;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));
    embedder = await createEmbedder();
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('forces Comedy picks with warm genres over a deterministic thriller taste', async () => {
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

    // Same steps as the recommendation route: embed the prompt and blend it
    // 50/50 with the taste vector before retrieval.
    const [promptVector] = await embedder([PROMPT]);

    if (promptVector === undefined) {
      throw new Error('Embedding model returned no vector for the prompt.');
    }

    const queryVector = combineQueryVector({ promptVector, tasteVector });

    if (queryVector === null) {
      throw new Error('Expected a combined prompt and taste query vector.');
    }

    const filters = parsePromptConstraints(PROMPT);
    expect(filters).toEqual({ genres: ['Comedy'] });
    if (filters === undefined) {
      throw new Error('Expected the lighthearted prompt to produce a Comedy filter.');
    }

    const mood = parsePromptMood(PROMPT);
    expect(mood).not.toBeNull();
    if (mood === null) {
      throw new Error('Expected the lighthearted prompt to produce mood weights.');
    }

    const result = await recommendMovies(db, {
      tasteVector: queryVector,
      filters,
      mood,
      limit: 4,
    });

    // Pins the 2026-11-21 alanvourch TMDB top-40k catalog snapshot and the
    // pinned embedding model. A catalog or model change can legitimately change
    // this order; update the fixture deliberately rather than loosening the
    // assertion.
    expect(result.movieIds).toEqual([1238440, 284, 3078, 164848]);

    const pickedRows = await db
      .select({ movieId: movies.id, title: movies.title, genres: movies.genres })
      .from(movies)
      .where(inArray(movies.id, result.movieIds));
    const byId = new Map(pickedRows.map((row) => [row.movieId, row]));
    const picks = result.movieIds.map((movieId) => {
      const pick = byId.get(movieId);

      if (pick === undefined) {
        throw new Error(`Recommended movieId ${String(movieId)} is missing from the catalog.`);
      }

      return pick;
    });

    for (const pick of picks) {
      expect(pick.genres).toContain('Comedy');
    }

    const warmGenres = picks.filter((pick) =>
      pick.genres.some(
        (genre) => genre === 'Romance' || genre === 'Family' || genre === 'Animation',
      ),
    );
    const romance = picks.filter((pick) => pick.genres.includes('Romance'));

    console.log(
      `lighthearted picks: ${picks
        .map((pick) => `${String(pick.movieId)} ${pick.title} [${pick.genres.join(', ')}]`)
        .join(' | ')}`,
    );

    expect(warmGenres.length).toBeGreaterThanOrEqual(3);
    expect(romance.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
