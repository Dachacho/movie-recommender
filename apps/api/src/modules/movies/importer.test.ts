import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { EMBEDDING_VERSION } from './embed.js';
import { buildEmbeddingText, importMovies } from './importer.js';

describe('buildEmbeddingText', () => {
  it('joins the available fields', () => {
    const text = buildEmbeddingText({
      title: 'Toy Story',
      overview: 'A cowboy doll feels threatened.',
      tagline: 'The toys are back.',
      genres: ['Animation'],
      keywords: ['friendship'],
    });

    expect(text).toBe(
      'Toy Story. A cowboy doll feels threatened. The toys are back. Animation. friendship',
    );
  });

  it('returns null when there is nothing to embed', () => {
    expect(
      buildEmbeddingText({
        title: 'Empty',
        overview: null,
        tagline: null,
        genres: [],
        keywords: [],
      }),
    ).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('importMovies', () => {
  const ids = [990_000_001, 990_000_002];
  const imdbId = 990_000_003;
  let pool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];

  beforeAll(() => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));
  });

  afterAll(async () => {
    await db.delete(movies).where(inArray(movies.id, [...ids, imdbId]));
    await pool.end();
  });

  it('is idempotent and stores 384-dimension embeddings', async () => {
    const texts: string[] = [];
    const embed = (batch: string[]) => {
      texts.push(...batch);

      return Promise.resolve(batch.map(() => new Array<number>(384).fill(0.1)));
    };

    const rows = ids.map((id) => ({
      id,
      title: `Fixture ${String(id)}`,
      overview: 'A fixture movie used by the importer test.',
      tagline: 'Testing only.',
      genres: ['Drama'],
      keywords: ['fixture'],
      cast: [],
      embedding: null,
      embeddingVersion: null,
    }));

    await importMovies({ db, embed, movies: rows, batchSize: 1 });
    await importMovies({ db, embed, movies: rows, batchSize: 1 });

    const stored = await db
      .select({
        id: movies.id,
        version: movies.embeddingVersion,
        dimensions: sql<number>`vector_dims(embedding)::int`,
      })
      .from(movies)
      .where(inArray(movies.id, ids));

    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.dimensions)).toEqual([384, 384]);
    expect(stored.map((row) => row.version)).toEqual([EMBEDDING_VERSION, EMBEDDING_VERSION]);
    expect(texts[0]).toContain('Testing only.');
    expect(texts).toHaveLength(4);
  });

  it('updates the IMDb evaluation columns when a movie already exists', async () => {
    const id = imdbId;
    const embed = (batch: string[]) =>
      Promise.resolve(batch.map(() => new Array<number>(384).fill(0.1)));
    const row = {
      id,
      title: 'IMDb Fixture',
      overview: 'A fixture movie used by the importer test.',
      genres: ['Drama'],
      keywords: ['fixture'],
      cast: [],
      embedding: null,
      embeddingVersion: null,
    };

    await importMovies({
      db,
      embed,
      movies: [{ ...row, imdbRating: 7.5, imdbVotes: 10105 }],
    });
    await importMovies({
      db,
      embed,
      movies: [{ ...row, imdbRating: 8.5, imdbVotes: 20000 }],
    });

    const stored = await db
      .select({ imdbRating: movies.imdbRating, imdbVotes: movies.imdbVotes })
      .from(movies)
      .where(eq(movies.id, id));

    expect(stored).toEqual([{ imdbRating: 8.5, imdbVotes: 20000 }]);
  });
});
