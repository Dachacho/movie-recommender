import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { EMBEDDING_VERSION } from './embed.js';
import { importMovies, prepareMovies } from './importer.js';

const MOVIE_HEADER =
  'adult,id,title,overview,tagline,release_date,runtime,genres,poster_path,popularity,vote_average,vote_count,status';
const CREDIT_HEADER = 'id,cast,crew';
const KEYWORD_HEADER = 'id,keywords';

describe('prepareMovies', () => {
  const moviesCsv = [
    MOVIE_HEADER,
    `False,1,Toy Story,"A cowboy doll feels threatened.","The toys are back.",1995-10-30,81.0,"[{'id': 16, 'name': 'Animation'}]",/poster.jpg,21.9,7.7,100,Released`,
    `False,1,Toy Story (duplicate),Old text,,1995-10-30,81.0,[],/poster.jpg,21.9,7.7,10,Released`,
    `False,2,No Overview,,,,2001-01-01,0.0,[],,1.0,0,5,Released`,
    `False,1997-08-20,Broken date,Some text,,1997-08-20,90.0,[],,1.0,0,5,Released`,
    `False,3,Rumored Film,Some text,,2020-01-01,90.0,[],,1.0,0,5,Rumored`,
    `True,4,Adult Film,Some text,,2020-01-01,90.0,[],,1.0,0,5,Released`,
  ].join('\n');
  const creditsCsv = [
    CREDIT_HEADER,
    `1,"[{'name': 'Tom Hanks', 'order': 0}]","[{'job': 'Director', 'name': 'John Lasseter'}]"`,
  ].join('\n');
  const keywordsCsv = [KEYWORD_HEADER, `1,"[{'id': 1, 'name': 'friendship'}]"`, `2,"[]"`].join(
    '\n',
  );

  it('keeps only clean, embeddable rows and joins credits and keywords', () => {
    expect(prepareMovies(moviesCsv, creditsCsv, keywordsCsv)).toEqual([
      expect.objectContaining({
        id: 1,
        title: 'Toy Story',
        tagline: 'The toys are back.',
        runtime: 81,
        genres: ['Animation'],
        keywords: ['friendship'],
        director: 'John Lasseter',
        cast: ['Tom Hanks'],
        voteCount: 100,
      }),
    ]);
  });

  it('applies the limit after cleaning', () => {
    expect(prepareMovies(moviesCsv, creditsCsv, keywordsCsv, 1)).toHaveLength(1);
  });

  it('rejects a CSV without the required columns', () => {
    expect(() => prepareMovies('id,title\n1,Toy Story\n', '', '')).toThrow(
      'CSV is missing required columns',
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)('importMovies', () => {
  const ids = [990_000_001, 990_000_002];
  let pool: Pool;
  let db: ReturnType<typeof createDatabase>['db'];

  beforeAll(() => {
    ({ db, pool } = createDatabase(process.env.DATABASE_URL));
  });

  afterAll(async () => {
    await db.delete(movies).where(inArray(movies.id, ids));
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
});
