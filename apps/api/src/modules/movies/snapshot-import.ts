import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase, type Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import { createEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_VERSION } from './embed.js';
import { importMovies } from './importer.js';
import { prepareSnapshot, SNAPSHOT_LIMIT } from './snapshot.js';

const batchSizeSchema = z.coerce.number().int().min(1).max(1024);
const pathSchema = z.string().trim().min(1);

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

function snapshotPath(): string {
  const result = pathSchema.safeParse(argument('csv') ?? process.env.SNAPSHOT_CSV);

  if (!result.success) {
    throw new Error('Provide --csv <path> or set SNAPSHOT_CSV to the TMDB snapshot CSV');
  }

  return result.data;
}

type CatalogCounts = {
  total: number;
  uniqueIds: number;
  missingEmbeddings: number;
  badDimensions: number;
  badVersions: number;
  nonFiniteEmbeddings: number;
};

async function verifyCatalog(db: Database, expected: number): Promise<CatalogCounts> {
  const result = await db.execute<CatalogCounts>(sql`
    select
      count(*)::int as "total",
      count(distinct id)::int as "uniqueIds",
      count(*) filter (where embedding is null)::int as "missingEmbeddings",
      count(*) filter (
        where embedding is not null and vector_dims(embedding) <> ${EMBEDDING_DIMENSIONS}
      )::int as "badDimensions",
      count(*) filter (
        where embedding_version is distinct from ${EMBEDDING_VERSION}
      )::int as "badVersions",
      count(*) filter (
        where embedding is not null and embedding::text ~* '(nan|infinity)'
      )::int as "nonFiniteEmbeddings"
    from ${movies}
  `);

  const counts = result.rows[0];

  if (counts === undefined) {
    throw new Error('Catalog verification returned no rows');
  }

  const problems: string[] = [];

  if (counts.total !== expected) {
    problems.push(`expected ${expected} rows, found ${counts.total}`);
  }

  if (counts.uniqueIds !== expected) {
    problems.push(`expected ${expected} unique ids, found ${counts.uniqueIds}`);
  }

  if (counts.missingEmbeddings !== 0) {
    problems.push(`${counts.missingEmbeddings} rows without an embedding`);
  }

  if (counts.badDimensions !== 0) {
    problems.push(`${counts.badDimensions} embeddings that are not ${EMBEDDING_DIMENSIONS}-d`);
  }

  if (counts.badVersions !== 0) {
    problems.push(`${counts.badVersions} rows without the current embedding version`);
  }

  if (counts.nonFiniteEmbeddings !== 0) {
    problems.push(`${counts.nonFiniteEmbeddings} embeddings with non-finite values`);
  }

  if (problems.length > 0) {
    throw new Error(`Catalog verification failed: ${problems.join('; ')}`);
  }

  return counts;
}

async function main(): Promise<void> {
  const path = snapshotPath();

  if (process.argv.includes('--limit')) {
    throw new Error(
      `The snapshot catalog size is fixed at ${SNAPSHOT_LIMIT}; --limit is not supported`,
    );
  }

  const batchSize = parseCount('batch-size', batchSizeSchema);

  const file = await stat(path);

  if (!file.isFile()) {
    throw new Error(`Snapshot path is not a file: ${path}`);
  }

  const { db, pool } = createDatabase();

  try {
    const parseStarted = Date.now();
    const { movies: prepared, stats } = await prepareSnapshot(
      createReadStream(path),
      SNAPSHOT_LIMIT,
    );
    const parseSeconds = Math.round((Date.now() - parseStarted) / 1000);

    console.log(`Snapshot: ${path} (${file.size} bytes)`);
    console.log(
      `Scanned ${stats.rows} rows: ${stats.invalid} invalid, ${stats.duplicates} duplicate ids, ${stats.qualified} qualified`,
    );
    console.log(`Selected ${stats.selected} movies by popularity in ${parseSeconds}s`);

    if (stats.selected !== SNAPSHOT_LIMIT || prepared.length !== SNAPSHOT_LIMIT) {
      throw new Error(
        `Curation selected ${stats.selected} movies, expected ${SNAPSHOT_LIMIT}; refusing to touch the catalog`,
      );
    }

    await db.execute(sql`truncate table ${movies}`);
    console.log('Truncated the movies table');

    const embed = await createEmbedder();
    const embedStarted = Date.now();
    let reported = 0;
    const { imported } = await importMovies({
      db,
      embed,
      movies: prepared,
      ...(batchSize === undefined ? {} : { batchSize }),
      onProgress: (done, total) => {
        if (done >= reported + 2000 || done === total) {
          reported = done;
          console.log(`Embedded ${done}/${total}`);
        }
      },
    });
    const embedSeconds = Math.round((Date.now() - embedStarted) / 1000);

    console.log(`Embedded and inserted ${imported} movies in ${embedSeconds}s`);

    const counts = await verifyCatalog(db, SNAPSHOT_LIMIT);

    console.log('Verification:', counts);
  } finally {
    await pool.end();
  }
}

await main();
