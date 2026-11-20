import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createEmbedder } from './embed.js';
import { importMovies, prepareMovies, readSourceFiles } from './importer.js';

const limitSchema = z.coerce.number().int().min(1).max(1_000_000);
const batchSizeSchema = z.coerce.number().int().min(1).max(1024);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

function parseCount(name: string, schema: z.ZodType<number>): number | undefined {
  const value = argument(name);

  if (value === undefined) {
    return undefined;
  }

  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(`Invalid --${name}: ${value}`);
  }

  return result.data;
}

async function verify(): Promise<void> {
  const { db, pool } = createDatabase();

  try {
    const result = await db.execute<{
      total: number;
      embedded: number;
      bad_dimensions: number;
      missing_year: number;
    }>(sql`
      select
        count(*)::int as total,
        count(embedding)::int as embedded,
        count(*) filter (where embedding is not null and vector_dims(embedding) <> 384)::int as bad_dimensions,
        count(*) filter (where release_year is null)::int as missing_year
      from ${movies}
    `);

    console.log('Catalog:', result.rows[0]);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--verify')) {
    await verify();

    return;
  }

  const dataDir = argument('data-dir') ?? process.env.CATALOG_DIR;

  if (dataDir === undefined || dataDir.trim().length === 0) {
    throw new Error('Provide --data-dir <path> or set CATALOG_DIR to the extracted dataset');
  }

  const limit = parseCount('limit', limitSchema);
  const batchSize = parseCount('batch-size', batchSizeSchema);

  const { db, pool } = createDatabase();

  try {
    const { moviesCsv, creditsCsv, keywordsCsv } = await readSourceFiles(dataDir);
    const prepared = prepareMovies(moviesCsv, creditsCsv, keywordsCsv, limit);

    console.log(`Prepared ${prepared.length} movies from ${dataDir}`);

    if (prepared.length === 0) {
      throw new Error('No movies survived cleaning; check the source files');
    }

    const embed = await createEmbedder();
    const started = Date.now();
    const { imported } = await importMovies({
      db,
      embed,
      movies: prepared,
      ...(batchSize === undefined ? {} : { batchSize }),
      onProgress: (done, total) => {
        console.log(`Embedded ${done}/${total}`);
      },
    });

    console.log(`Imported ${imported} movies in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await pool.end();
  }
}

await main();
