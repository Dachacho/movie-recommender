import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { NewMovie } from '../../db/schema.js';
import { movies } from '../../db/schema.js';
import { parseCsv } from './csv.js';
import { EMBEDDING_VERSION, type Embedder } from './embed.js';
import {
  buildEmbeddingText,
  dedupeById,
  parseCredits,
  parseNamedList,
  toNewMovie,
  type Credits,
} from './parse.js';

const CAST_LIMIT = 8;

function* objectRows(text: string, required: readonly string[]): Generator<Record<string, string>> {
  const parser = parseCsv(text);
  const headerRow = parser.next();

  if (headerRow.done === true) {
    throw new Error('CSV is empty');
  }

  const header = headerRow.value;
  const missing = required.filter((column) => !header.includes(column));

  if (missing.length > 0) {
    throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
  }

  for (const row of parser) {
    const object: Record<string, string> = {};

    header.forEach((column, index) => {
      object[column] = row[index] ?? '';
    });

    yield object;
  }
}

const MOVIE_COLUMNS = [
  'id',
  'title',
  'overview',
  'tagline',
  'release_date',
  'runtime',
  'genres',
  'poster_path',
  'popularity',
  'vote_average',
  'vote_count',
  'status',
  'adult',
] as const;
const CREDIT_COLUMNS = ['id', 'cast', 'crew'] as const;
const KEYWORD_COLUMNS = ['id', 'keywords'] as const;

export function prepareMovies(
  moviesCsv: string,
  creditsCsv: string,
  keywordsCsv: string,
  limit?: number,
): NewMovie[] {
  const creditsById = new Map<string, Credits>();

  if (creditsCsv.length > 0) {
    for (const row of objectRows(creditsCsv, CREDIT_COLUMNS)) {
      const id = (row['id'] ?? '').trim();

      if (id.length > 0) {
        creditsById.set(id, parseCredits(row['cast'] ?? '', row['crew'] ?? '', CAST_LIMIT));
      }
    }
  }

  const keywordsById = new Map<string, string[]>();

  if (keywordsCsv.length > 0) {
    for (const row of objectRows(keywordsCsv, KEYWORD_COLUMNS)) {
      const id = (row['id'] ?? '').trim();

      if (id.length > 0) {
        keywordsById.set(id, parseNamedList(row['keywords'] ?? ''));
      }
    }
  }

  const prepared: NewMovie[] = [];

  for (const row of objectRows(moviesCsv, MOVIE_COLUMNS)) {
    const id = (row['id'] ?? '').trim();
    const movie = toNewMovie(row, creditsById.get(id), keywordsById.get(id) ?? []);

    if (movie !== null) {
      prepared.push(movie);
    }
  }

  const unique = dedupeById(prepared);

  return limit === undefined ? unique : unique.slice(0, limit);
}

export async function readSourceFiles(dataDir: string): Promise<{
  moviesCsv: string;
  creditsCsv: string;
  keywordsCsv: string;
}> {
  const [moviesCsv, creditsCsv, keywordsCsv] = await Promise.all([
    readFile(join(dataDir, 'movies_metadata.csv'), 'utf8'),
    readFile(join(dataDir, 'credits.csv'), 'utf8'),
    readFile(join(dataDir, 'keywords.csv'), 'utf8'),
  ]);

  return { moviesCsv, creditsCsv, keywordsCsv };
}

export interface ImportMoviesOptions {
  db: Database;
  embed: Embedder;
  movies: NewMovie[];
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function importMovies({
  db,
  embed,
  movies: prepared,
  batchSize = 64,
  onProgress,
}: ImportMoviesOptions): Promise<{ imported: number }> {
  let imported = 0;

  for (let start = 0; start < prepared.length; start += batchSize) {
    const batch = prepared.slice(start, start + batchSize);
    const texts = batch.map((movie) => {
      const text = buildEmbeddingText({
        title: movie.title,
        overview: movie.overview ?? null,
        tagline: movie.tagline ?? null,
        genres: movie.genres ?? [],
        keywords: movie.keywords ?? [],
      });

      if (text === null) {
        throw new Error(`Movie ${movie.id} has no text to embed`);
      }

      return text;
    });

    const vectors = await embed(texts);

    const rows = batch.map((movie, index) => ({
      ...movie,
      embedding: vectors[index] ?? null,
      embeddingVersion: EMBEDDING_VERSION,
    }));

    await db
      .insert(movies)
      .values(rows)
      .onConflictDoUpdate({
        target: movies.id,
        set: {
          title: sql.raw('excluded."title"'),
          releaseYear: sql.raw('excluded."release_year"'),
          overview: sql.raw('excluded."overview"'),
          tagline: sql.raw('excluded."tagline"'),
          runtime: sql.raw('excluded."runtime"'),
          genres: sql.raw('excluded."genres"'),
          keywords: sql.raw('excluded."keywords"'),
          director: sql.raw('excluded."director"'),
          cast: sql.raw('excluded."cast"'),
          posterPath: sql.raw('excluded."poster_path"'),
          popularity: sql.raw('excluded."popularity"'),
          voteAverage: sql.raw('excluded."vote_average"'),
          voteCount: sql.raw('excluded."vote_count"'),
          embedding: sql.raw('excluded."embedding"'),
          embeddingVersion: sql.raw('excluded."embedding_version"'),
        },
      });

    imported += rows.length;
    onProgress?.(imported, prepared.length);
  }

  return { imported };
}
