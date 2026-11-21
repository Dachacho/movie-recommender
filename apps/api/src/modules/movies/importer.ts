import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { NewMovie } from '../../db/schema.js';
import { movies } from '../../db/schema.js';
import { EMBEDDING_VERSION, type Embedder } from './embed.js';

export interface EmbeddingInput {
  title: string;
  overview: string | null;
  tagline: string | null;
  genres: string[];
  keywords: string[];
}

export function buildEmbeddingText(movie: EmbeddingInput): string | null {
  const parts = [
    movie.title,
    movie.overview ?? '',
    movie.tagline ?? '',
    ...movie.genres,
    ...movie.keywords,
  ]
    .map((part) => part.trim().replace(/\.+$/, ''))
    .filter((part) => part.length > 0);

  return parts.length > 1 ? parts.join('. ') : null;
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
