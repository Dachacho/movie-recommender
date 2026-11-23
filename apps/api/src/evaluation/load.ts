import { createReadStream } from 'node:fs';
import { asc, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { movies } from '../db/schema.js';
import { readCsvRecords } from '../modules/movies/snapshot.js';

/** A MovieLens rating whose MovieLens movie id was mapped to a catalog TMDB id. */
export interface MappedRating {
  userId: number;
  movieId: number;
  rating: number;
  timestamp: number;
}

/** The catalog fields the evaluation baselines need. */
export interface CatalogEntry {
  movieId: number;
  voteCount: number | null;
  genres: string[];
}

export interface RawRating {
  userId: number;
  movieLensMovieId: number;
  rating: number;
  timestamp: number;
}

export interface LinksResult {
  links: Map<number, number>;
  stats: { rows: number; valid: number; invalid: number; duplicates: number };
}

export interface RatingsResult {
  ratings: RawRating[];
  stats: { rows: number; invalid: number };
}

export interface MappingResult {
  ratings: MappedRating[];
  stats: { unmapped: number; missingFromCatalog: number; duplicates: number; kept: number };
}

export interface CoverageStats {
  catalogMovies: number;
  linkRows: number;
  validLinks: number;
  invalidLinks: number;
  duplicateLinks: number;
  catalogMappedFilms: number;
  ratingRows: number;
  invalidRatings: number;
  unmappedRatings: number;
  missingFromCatalog: number;
  duplicateRatings: number;
  keptRatings: number;
  keptUsers: number;
  keptMovies: number;
}

const LINK_COLUMNS = ['movieId', 'tmdbId'] as const;
const RATING_COLUMNS = ['userId', 'movieId', 'rating', 'timestamp'] as const;
const EMBEDDING_CHUNK_SIZE = 5_000;

const linkRowSchema = z.object({
  movieId: z.coerce.number().int().positive(),
  tmdbId: z.coerce.number().int().positive(),
});

const ratingRowSchema = z.object({
  userId: z.coerce.number().int().positive(),
  movieId: z.coerce.number().int().positive(),
  rating: z.coerce
    .number()
    .min(0.5)
    .max(5)
    .refine((value) => Number.isInteger(value * 2), {
      message: 'rating must be a half-star value',
    }),
  timestamp: z.coerce.number().int().nonnegative(),
});

function requireColumns(
  header: readonly string[],
  required: readonly string[],
  name: string,
): Map<string, number> {
  const positions = new Map<string, number>();

  header.forEach((column, index) => {
    positions.set(column, index);
  });

  const missing = required.filter((column) => !positions.has(column));

  if (missing.length > 0) {
    throw new Error(`${name} CSV is missing required columns: ${missing.join(', ')}`);
  }

  return positions;
}

function isBlankRow(record: readonly string[]): boolean {
  return record.length <= 1 && (record[0]?.trim() ?? '') === '';
}

/** Streams links.csv (movieId, imdbId, tmdbId) into a MovieLens to TMDB map. */
export async function parseLinks(source: AsyncIterable<Buffer | string>): Promise<LinksResult> {
  const records = readCsvRecords(source);
  const header = await records.next();

  if (header.done === true) {
    throw new Error('links CSV is empty');
  }

  const positions = requireColumns(header.value, LINK_COLUMNS, 'links');
  const movieIdAt = positions.get('movieId') ?? -1;
  const tmdbIdAt = positions.get('tmdbId') ?? -1;
  const links = new Map<number, number>();
  let rows = 0;
  let invalid = 0;
  let duplicates = 0;

  for await (const record of records) {
    if (isBlankRow(record)) {
      continue;
    }

    rows += 1;
    const parsed = linkRowSchema.safeParse({
      movieId: record[movieIdAt] ?? '',
      tmdbId: record[tmdbIdAt] ?? '',
    });

    if (!parsed.success) {
      invalid += 1;
      continue;
    }

    if (links.has(parsed.data.movieId)) {
      duplicates += 1;
      continue;
    }

    links.set(parsed.data.movieId, parsed.data.tmdbId);
  }

  return { links, stats: { rows, valid: links.size, invalid, duplicates } };
}

/** Streams ratings_small.csv (userId, movieId, rating, timestamp). */
export async function parseRatings(source: AsyncIterable<Buffer | string>): Promise<RatingsResult> {
  const records = readCsvRecords(source);
  const header = await records.next();

  if (header.done === true) {
    throw new Error('ratings CSV is empty');
  }

  const positions = requireColumns(header.value, RATING_COLUMNS, 'ratings');
  const userIdAt = positions.get('userId') ?? -1;
  const movieIdAt = positions.get('movieId') ?? -1;
  const ratingAt = positions.get('rating') ?? -1;
  const timestampAt = positions.get('timestamp') ?? -1;
  const ratings: RawRating[] = [];
  let rows = 0;
  let invalid = 0;

  for await (const record of records) {
    if (isBlankRow(record)) {
      continue;
    }

    rows += 1;
    const parsed = ratingRowSchema.safeParse({
      userId: record[userIdAt] ?? '',
      movieId: record[movieIdAt] ?? '',
      rating: record[ratingAt] ?? '',
      timestamp: record[timestampAt] ?? '',
    });

    if (!parsed.success) {
      invalid += 1;
      continue;
    }

    ratings.push({
      userId: parsed.data.userId,
      movieLensMovieId: parsed.data.movieId,
      rating: parsed.data.rating,
      timestamp: parsed.data.timestamp,
    });
  }

  return { ratings, stats: { rows, invalid } };
}

/** Maps MovieLens ratings to catalog TMDB ids, dropping unseen and duplicate films. */
export function mapRatings(
  links: ReadonlyMap<number, number>,
  ratings: readonly RawRating[],
  catalogIds: ReadonlySet<number>,
): MappingResult {
  const mapped: MappedRating[] = [];
  const seen = new Set<string>();
  let unmapped = 0;
  let missingFromCatalog = 0;
  let duplicates = 0;

  for (const rating of ratings) {
    const movieId = links.get(rating.movieLensMovieId);

    if (movieId === undefined) {
      unmapped += 1;
      continue;
    }

    if (!catalogIds.has(movieId)) {
      missingFromCatalog += 1;
      continue;
    }

    const key = `${String(rating.userId)}:${String(movieId)}`;

    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
    mapped.push({
      userId: rating.userId,
      movieId,
      rating: rating.rating,
      timestamp: rating.timestamp,
    });
  }

  return {
    ratings: mapped,
    stats: { unmapped, missingFromCatalog, duplicates, kept: mapped.length },
  };
}

export async function loadCatalogIds(db: Database): Promise<Set<number>> {
  const rows = await db.select({ id: movies.id }).from(movies);

  return new Set(rows.map((row) => row.id));
}

/** Every film the recommendation API can rank, ordered by id. */
export async function loadCatalogUniverse(db: Database): Promise<CatalogEntry[]> {
  return db
    .select({
      movieId: movies.id,
      voteCount: movies.voteCount,
      genres: movies.genres,
    })
    .from(movies)
    .where(isNotNull(movies.embedding))
    .orderBy(asc(movies.id));
}

export async function loadMovieEmbeddings(
  db: Database,
  movieIds: readonly number[],
): Promise<Map<number, number[]>> {
  const ids = [...new Set(movieIds)];
  const embeddings = new Map<number, number[]>();

  for (let start = 0; start < ids.length; start += EMBEDDING_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + EMBEDDING_CHUNK_SIZE);

    if (chunk.length === 0) {
      continue;
    }

    const rows = await db
      .select({ movieId: movies.id, embedding: movies.embedding })
      .from(movies)
      .where(inArray(movies.id, chunk));

    for (const row of rows) {
      if (row.embedding !== null) {
        embeddings.set(row.movieId, row.embedding);
      }
    }
  }

  return embeddings;
}

/** Reads links + ratings from disk and keeps only ratings that map into the catalog. */
export async function loadEvaluationData(input: {
  db: Database;
  linksPath: string;
  ratingsPath: string;
}): Promise<{ ratings: MappedRating[]; coverage: CoverageStats }> {
  const [catalogIds, linksResult, ratingsResult] = await Promise.all([
    loadCatalogIds(input.db),
    parseLinks(createReadStream(input.linksPath)),
    parseRatings(createReadStream(input.ratingsPath)),
  ]);
  const mapped = mapRatings(linksResult.links, ratingsResult.ratings, catalogIds);

  let catalogMappedFilms = 0;

  for (const movieId of linksResult.links.values()) {
    if (catalogIds.has(movieId)) {
      catalogMappedFilms += 1;
    }
  }

  return {
    ratings: mapped.ratings,
    coverage: {
      catalogMovies: catalogIds.size,
      linkRows: linksResult.stats.rows,
      validLinks: linksResult.stats.valid,
      invalidLinks: linksResult.stats.invalid,
      duplicateLinks: linksResult.stats.duplicates,
      catalogMappedFilms,
      ratingRows: ratingsResult.stats.rows,
      invalidRatings: ratingsResult.stats.invalid,
      unmappedRatings: mapped.stats.unmapped,
      missingFromCatalog: mapped.stats.missingFromCatalog,
      duplicateRatings: mapped.stats.duplicates,
      keptRatings: mapped.ratings.length,
      keptUsers: new Set(mapped.ratings.map((rating) => rating.userId)).size,
      keptMovies: new Set(mapped.ratings.map((rating) => rating.movieId)).size,
    },
  };
}
