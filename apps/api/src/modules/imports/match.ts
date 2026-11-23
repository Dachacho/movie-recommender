import type { LetterboxdMatched, LetterboxdUnmatched } from '@movie-recommender/shared';
import { MalformedCsvError, parseCsv } from '../movies/csv.js';

export const MAX_IMPORT_ROWS = 5_000;
const MAX_NAME_LENGTH = 200;

const MIN_RELEASE_YEAR = 1870;
const MAX_RELEASE_YEAR = 2100;
const YEAR_PATTERN = /^\d{4}$/;
const RATING_PATTERN = /^\d+(\.\d+)?$/;

export class LetterboxdCsvError extends Error {
  constructor(message = 'CSV must be a Letterboxd ratings or watches export.') {
    super(message);
    this.name = 'LetterboxdCsvError';
  }
}

export interface LetterboxdRow {
  name: string;
  normalizedTitle: string;
  year: number | null;
  rating: number | null;
}

export interface ParsedLetterboxdCsv {
  rows: LetterboxdRow[];
  invalid: number;
}

export interface CatalogCandidate {
  movieId: number;
  title: string;
  releaseYear: number | null;
}

export type CatalogCandidateIndex = ReadonlyMap<string, readonly CatalogCandidate[]>;

export interface LetterboxdMatchReport {
  matched: LetterboxdMatched[];
  unmatched: LetterboxdUnmatched[];
}

/**
 * Lowercases and collapses every run of punctuation or whitespace into one
 * space. Accents are preserved, so "Amélie" only matches a catalog title with
 * the same accent.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseYear(value: string): number | null | undefined {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (!YEAR_PATTERN.test(trimmed)) {
    return undefined;
  }

  const year = Number(trimmed);

  return year >= MIN_RELEASE_YEAR && year <= MAX_RELEASE_YEAR ? year : undefined;
}

function parseRating(value: string): number | null | undefined {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (!RATING_PATTERN.test(trimmed)) {
    return undefined;
  }

  const rating = Number(trimmed);

  if (!Number.isFinite(rating) || rating < 0.5 || rating > 5 || !Number.isInteger(rating * 2)) {
    return undefined;
  }

  return rating;
}

interface HeaderColumns {
  name: number;
  year: number | null;
  rating: number | null;
}

function readHeader(record: readonly string[]): HeaderColumns {
  const columns = record.map((cell) =>
    cell
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase(),
  );
  const name = columns.indexOf('name');

  if (name === -1) {
    throw new LetterboxdCsvError('CSV must include a Name column.');
  }

  const year = columns.indexOf('year');
  const rating = columns.indexOf('rating');

  return {
    name,
    year: year === -1 ? null : year,
    rating: rating === -1 ? null : rating,
  };
}

function parseRow(
  record: readonly string[],
  header: HeaderColumns,
  headerLength: number,
): LetterboxdRow | null {
  if (record.length > headerLength) {
    return null;
  }

  const name = (record[header.name] ?? '').trim();
  const normalizedTitle = normalizeTitle(name);

  if (name.length === 0 || name.length > MAX_NAME_LENGTH || normalizedTitle.length === 0) {
    return null;
  }

  const year = header.year === null ? null : parseYear(record[header.year] ?? '');

  if (year === undefined) {
    return null;
  }

  const rating = header.rating === null ? null : parseRating(record[header.rating] ?? '');

  if (rating === undefined) {
    return null;
  }

  return { name, normalizedTitle, year, rating };
}

export function parseLetterboxdCsv(csv: string): ParsedLetterboxdCsv {
  try {
    return parseLetterboxdRecords(csv);
  } catch (error) {
    if (error instanceof MalformedCsvError) {
      throw new LetterboxdCsvError();
    }

    throw error;
  }
}

function parseLetterboxdRecords(csv: string): ParsedLetterboxdCsv {
  const records = parseCsv(csv);
  const first = records.next();

  if (first.done === true) {
    throw new LetterboxdCsvError();
  }

  const header = readHeader(first.value);
  const headerLength = first.value.length;
  const rows: LetterboxdRow[] = [];
  let invalid = 0;
  let total = 0;

  for (const record of records) {
    total += 1;

    if (total > MAX_IMPORT_ROWS) {
      throw new LetterboxdCsvError(`Imports are limited to ${MAX_IMPORT_ROWS} rows.`);
    }

    const row = parseRow(record, header, headerLength);

    if (row === null) {
      invalid += 1;
    } else {
      rows.push(row);
    }
  }

  return { rows, invalid };
}

export function indexCatalogCandidates(
  candidates: readonly CatalogCandidate[],
): CatalogCandidateIndex {
  const index = new Map<string, CatalogCandidate[]>();

  for (const candidate of candidates) {
    const key = normalizeTitle(candidate.title);

    if (key.length === 0) {
      continue;
    }

    const bucket = index.get(key);

    if (bucket === undefined) {
      index.set(key, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  return index;
}

/**
 * Picks a candidate for one import row. Year tolerance is one year; an exact
 * year wins, then the smallest difference, then the lowest movie id. A row
 * without a year matches by title alone and therefore falls back to the
 * lowest movie id.
 */
export function pickCatalogCandidate(
  row: Pick<LetterboxdRow, 'normalizedTitle' | 'year'>,
  index: CatalogCandidateIndex,
): CatalogCandidate | null {
  const candidates = index.get(row.normalizedTitle);

  if (candidates === undefined) {
    return null;
  }

  let best: CatalogCandidate | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    let delta = 0;

    if (row.year !== null) {
      if (candidate.releaseYear === null) {
        continue;
      }

      delta = Math.abs(row.year - candidate.releaseYear);

      if (delta > 1) {
        continue;
      }
    }

    if (
      delta < bestDelta ||
      (delta === bestDelta && (best === null || candidate.movieId < best.movieId))
    ) {
      best = candidate;
      bestDelta = delta;
    }
  }

  return best;
}

/**
 * Matches parsed rows against the candidate index. Duplicates that resolve to
 * the same film (or, for unmatched rows, the same title and year) keep their
 * first position and the last occurrence's rating wins.
 */
export function matchLetterboxdRows(
  rows: readonly LetterboxdRow[],
  index: CatalogCandidateIndex,
): LetterboxdMatchReport {
  const matched = new Map<number, LetterboxdMatched>();
  const unmatched = new Map<string, LetterboxdUnmatched>();

  for (const row of rows) {
    const candidate = pickCatalogCandidate(row, index);

    if (candidate !== null) {
      matched.set(candidate.movieId, {
        movieId: candidate.movieId,
        title: candidate.title,
        releaseYear: candidate.releaseYear,
        rating: row.rating,
      });
      continue;
    }

    const key = `${row.normalizedTitle}\u0000${row.year === null ? '' : String(row.year)}`;

    unmatched.set(key, { name: row.name, year: row.year, reason: 'no_match' });
  }

  return { matched: [...matched.values()], unmatched: [...unmatched.values()] };
}
