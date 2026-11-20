import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('movies schema', () => {
  let pool: Pool;

  beforeAll(() => {
    ({ pool } = createDatabase(connectionString));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('stores the embedding as a 384-dimension vector', async () => {
    const result = await pool.query<{ type: string; dimensions: number }>(
      `select atttypid::regtype::text as type, atttypmod as dimensions
       from pg_attribute
       where attrelid = 'movies'::regclass and attname = 'embedding'`,
    );

    expect(result.rows).toEqual([{ type: 'vector', dimensions: 384 }]);
  });

  it('uses the TMDB id as the primary key', async () => {
    const result = await pool.query<{ column: string }>(
      `select a.attname as column
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = 'movies'::regclass and i.indisprimary`,
    );

    expect(result.rows).toEqual([{ column: 'id' }]);
  });

  it('has the pgvector extension installed', async () => {
    const result = await pool.query<{ extname: string }>(
      `select extname from pg_extension where extname = 'vector'`,
    );

    expect(result.rows).toEqual([{ extname: 'vector' }]);
  });
});
