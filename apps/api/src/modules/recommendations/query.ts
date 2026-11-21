import {
  and,
  arrayOverlaps,
  asc,
  cosineDistance,
  gte,
  inArray,
  isNotNull,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { movies } from '../../db/schema.js';
import {
  EXPECTED_EMBEDDING_DIMENSIONS,
  MAX_ID_COUNT,
  MAX_QUERY_LIMIT,
  type MovieCandidate,
  type RecommendationFilters,
  type ScoredCandidate,
} from './types.js';

const MIN_RELEASE_YEAR = 1870;
const MAX_RELEASE_YEAR = 2100;
const MAX_GENRE_COUNT = 20;

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new RangeError(
      `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}, received ${limit}.`,
    );
  }
}

function validateEmbedding(embedding: readonly number[]): void {
  if (embedding.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new RangeError(
      `embedding must have exactly ${EXPECTED_EMBEDDING_DIMENSIONS} dimensions, received ${embedding.length}.`,
    );
  }

  for (let index = 0; index < embedding.length; index += 1) {
    const value = embedding[index];

    if (value === undefined || !Number.isFinite(value)) {
      throw new RangeError(`embedding[${index}] must be a finite number, received ${value}.`);
    }
  }
}

function validateIds(ids: readonly number[] | undefined, name: string): void {
  if (ids === undefined) {
    return;
  }

  if (ids.length > MAX_ID_COUNT) {
    throw new RangeError(
      `${name} must contain at most ${MAX_ID_COUNT} ids, received ${ids.length}.`,
    );
  }

  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new RangeError(`${name} must contain only positive integer ids, received ${id}.`);
    }
  }
}

function validateIntegerBound(
  value: number | undefined,
  name: string,
  min: number,
  max?: number,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const expected =
      max === undefined
        ? `an integer greater than or equal to ${min}`
        : `an integer from ${min} to ${max}`;

    throw new RangeError(`${name} must be ${expected}, received ${value}.`);
  }
}

function validateFilters(filters: RecommendationFilters | undefined): void {
  if (filters === undefined) {
    return;
  }

  validateIntegerBound(filters.runtimeMin, 'runtimeMin', 0);
  validateIntegerBound(filters.runtimeMax, 'runtimeMax', 0);

  if (
    filters.runtimeMin !== undefined &&
    filters.runtimeMax !== undefined &&
    filters.runtimeMin > filters.runtimeMax
  ) {
    throw new RangeError(
      `runtimeMin must not exceed runtimeMax, received ${filters.runtimeMin} > ${filters.runtimeMax}.`,
    );
  }

  validateIntegerBound(filters.yearMin, 'yearMin', MIN_RELEASE_YEAR, MAX_RELEASE_YEAR);
  validateIntegerBound(filters.yearMax, 'yearMax', MIN_RELEASE_YEAR, MAX_RELEASE_YEAR);

  if (
    filters.yearMin !== undefined &&
    filters.yearMax !== undefined &&
    filters.yearMin > filters.yearMax
  ) {
    throw new RangeError(
      `yearMin must not exceed yearMax, received ${filters.yearMin} > ${filters.yearMax}.`,
    );
  }

  if (filters.genres !== undefined) {
    if (filters.genres.length > MAX_GENRE_COUNT) {
      throw new RangeError(
        `genres must contain at most ${MAX_GENRE_COUNT} entries, received ${filters.genres.length}.`,
      );
    }

    for (const genre of filters.genres) {
      if (typeof genre !== 'string' || genre.length === 0) {
        throw new RangeError(
          `genres must contain only non-empty strings, received ${String(genre)}.`,
        );
      }
    }
  }
}

function buildWhere(
  filters: RecommendationFilters | undefined,
  excludeIds: readonly number[] | undefined,
  candidateIds: readonly number[] | undefined,
): SQL | undefined {
  const conditions: SQL[] = [isNotNull(movies.embedding)];

  if (candidateIds !== undefined) {
    conditions.push(inArray(movies.id, [...candidateIds]));
  }

  if (excludeIds !== undefined && excludeIds.length > 0) {
    conditions.push(notInArray(movies.id, [...excludeIds]));
  }

  if (filters?.runtimeMin !== undefined) {
    conditions.push(gte(movies.runtime, filters.runtimeMin));
  }

  if (filters?.runtimeMax !== undefined) {
    conditions.push(lte(movies.runtime, filters.runtimeMax));
  }

  if (filters?.yearMin !== undefined) {
    conditions.push(gte(movies.releaseYear, filters.yearMin));
  }

  if (filters?.yearMax !== undefined) {
    conditions.push(lte(movies.releaseYear, filters.yearMax));
  }

  if (filters?.genres !== undefined && filters.genres.length > 0) {
    conditions.push(arrayOverlaps(movies.genres, [...filters.genres]));
  }

  return and(...conditions);
}

function requireEmbedding(embedding: number[] | null): number[] {
  if (embedding === null) {
    throw new Error('Candidate query returned a movie without an embedding.');
  }

  return embedding;
}

function hasEmptyCandidateList(candidateIds: readonly number[] | undefined): boolean {
  return candidateIds !== undefined && candidateIds.length === 0;
}

export async function findNearestMovies(
  db: Database,
  input: {
    embedding: readonly number[];
    filters?: RecommendationFilters;
    excludeIds?: readonly number[];
    candidateIds?: readonly number[];
    limit: number;
  },
): Promise<ScoredCandidate[]> {
  validateLimit(input.limit);
  validateEmbedding(input.embedding);
  validateFilters(input.filters);
  validateIds(input.excludeIds, 'excludeIds');
  validateIds(input.candidateIds, 'candidateIds');

  if (hasEmptyCandidateList(input.candidateIds)) {
    return [];
  }

  const distance = sql<number>`${cosineDistance(movies.embedding, JSON.stringify(input.embedding))}`;
  const rows = await db
    .select({
      movieId: movies.id,
      embedding: movies.embedding,
      voteAverage: movies.voteAverage,
      voteCount: movies.voteCount,
      distance,
    })
    .from(movies)
    .where(buildWhere(input.filters, input.excludeIds, input.candidateIds))
    .orderBy(asc(distance), asc(movies.id))
    .limit(input.limit);

  return rows.map((row) => ({
    movieId: row.movieId,
    embedding: requireEmbedding(row.embedding),
    voteAverage: row.voteAverage,
    voteCount: row.voteCount,
    similarity: 1 - row.distance,
  }));
}

export async function findColdStartPool(
  db: Database,
  input: {
    filters?: RecommendationFilters;
    excludeIds?: readonly number[];
    candidateIds?: readonly number[];
    limit: number;
  },
): Promise<MovieCandidate[]> {
  validateLimit(input.limit);
  validateFilters(input.filters);
  validateIds(input.excludeIds, 'excludeIds');
  validateIds(input.candidateIds, 'candidateIds');

  if (hasEmptyCandidateList(input.candidateIds)) {
    return [];
  }

  const rows = await db
    .select({
      movieId: movies.id,
      embedding: movies.embedding,
      voteAverage: movies.voteAverage,
      voteCount: movies.voteCount,
    })
    .from(movies)
    .where(buildWhere(input.filters, input.excludeIds, input.candidateIds))
    .orderBy(asc(sql`md5(${movies.id}::text)`))
    .limit(input.limit);

  return rows.map((row) => ({
    movieId: row.movieId,
    embedding: requireEmbedding(row.embedding),
    voteAverage: row.voteAverage,
    voteCount: row.voteCount,
  }));
}
