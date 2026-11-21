import { StringDecoder } from 'node:string_decoder';
import type { NewMovie } from '../../db/schema.js';
import { parseCsv } from './csv.js';

export const SNAPSHOT_LIMIT = 40_000;

/** Columns the snapshot importer reads; extra columns in the source are ignored. */
export const SNAPSHOT_COLUMNS = [
  'id',
  'title',
  'vote_average',
  'vote_count',
  'status',
  'release_date',
  'runtime',
  'overview',
  'popularity',
  'tagline',
  'genres',
  'cast',
  'director',
  'poster_path',
  'keywords',
] as const;

const TITLE_MAX = 512;
const OVERVIEW_MAX = 4000;
const TAGLINE_MAX = 500;
const DIRECTOR_MAX = 300;
const NAME_MAX = 200;
const GENRES_MAX = 20;
const KEYWORDS_MAX = 50;
const CAST_MAX = 8;
const RUNTIME_MAX = 100_000;
const MIN_YEAR = 1870;
const MAX_YEAR = 2100;
const MAX_MOVIE_ID = 2_147_483_647;

/** A movie that passed validation and is rankable for curation. */
export type QualifiedMovie = NewMovie & { popularity: number };

export interface SnapshotStats {
  rows: number;
  invalid: number;
  duplicates: number;
  qualified: number;
  selected: number;
}

export interface SnapshotResult {
  movies: QualifiedMovie[];
  stats: SnapshotStats;
}

/**
 * Streams CSV records out of an async source. Newlines inside quoted fields are
 * kept, quotes are escaped by doubling and records may span chunks.
 */
export async function* readCsvRecords(
  source: AsyncIterable<Buffer | string>,
): AsyncGenerator<string[]> {
  let buffer = '';
  let inQuotes = false;
  let scanIndex = 0;
  let recordStart = 0;
  const decoder = new StringDecoder('utf8');

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    while (scanIndex < buffer.length) {
      const code = buffer.charCodeAt(scanIndex);

      if (code === 34) {
        inQuotes = !inQuotes;
        scanIndex += 1;
        continue;
      }

      if (code === 10 && !inQuotes) {
        const record = buffer.slice(recordStart, scanIndex);
        scanIndex += 1;
        recordStart = scanIndex;

        yield* parseCsv(record);
        continue;
      }

      scanIndex += 1;
    }

    buffer = buffer.slice(recordStart);
    scanIndex -= recordStart;
    recordStart = 0;
  }

  buffer += decoder.end();

  if (buffer.length > 0) {
    yield* parseCsv(buffer);
  }
}

function parseNumber(value: string | undefined): number | null {
  const text = value?.trim() ?? '';

  if (text.length === 0) {
    return null;
  }

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  const parsed = parseNumber(value);

  return parsed === null ? null : Math.trunc(parsed);
}

function parseReleaseYear(value: string | undefined): number | null {
  const match = /^(\d{4})/.exec(value?.trim() ?? '');
  const year = match?.[1] === undefined ? null : Number(match[1]);

  return year !== null && year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

function parseRuntime(value: string | undefined): number | null {
  const runtime = parseNumber(value);

  if (runtime === null || runtime <= 0 || runtime > RUNTIME_MAX) {
    return null;
  }

  const minutes = Math.round(runtime);

  return minutes > 0 ? minutes : null;
}

function parsePosterPath(value: string | undefined): string | null {
  const path = value?.trim() ?? '';

  return path.startsWith('/') ? path : null;
}

function boundedText(value: string | undefined, maxLength: number): string {
  return (value ?? '').trim().slice(0, maxLength);
}

function splitList(value: string | undefined, separator: string, limit: number): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const raw of (value ?? '').split(separator)) {
    const entry = raw.trim().slice(0, NAME_MAX);

    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    entries.push(entry);

    if (entries.length === limit) {
      break;
    }
  }

  return entries;
}

export function toSnapshotMovie(row: Record<string, string>): QualifiedMovie | null {
  const rawId = (row['id'] ?? '').trim();

  if (!/^\d+$/.test(rawId)) {
    return null;
  }

  const id = Number(rawId);

  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_MOVIE_ID) {
    return null;
  }

  if ((row['status'] ?? '').trim() !== 'Released') {
    return null;
  }

  const title = boundedText(row['title'], TITLE_MAX);
  const overview = boundedText(row['overview'], OVERVIEW_MAX);
  const tagline = boundedText(row['tagline'], TAGLINE_MAX);
  const director = boundedText(row['director'], DIRECTOR_MAX);

  if (title.length === 0 || overview.length === 0) {
    return null;
  }

  const runtime = parseRuntime(row['runtime']);
  const popularity = parseNumber(row['popularity']);

  if (runtime === null || popularity === null) {
    return null;
  }

  return {
    id,
    title,
    releaseYear: parseReleaseYear(row['release_date']),
    overview,
    tagline: tagline.length > 0 ? tagline : null,
    runtime,
    genres: splitList(row['genres'], ',', GENRES_MAX),
    keywords: splitList(row['keywords'], '|', KEYWORDS_MAX),
    director: director.length > 0 ? director : null,
    cast: splitList(row['cast'], ',', CAST_MAX),
    posterPath: parsePosterPath(row['poster_path']),
    popularity,
    voteAverage: parseNumber(row['vote_average']),
    voteCount: parseInteger(row['vote_count']),
    embedding: null,
    embeddingVersion: null,
  };
}

/** True when `left` ranks below `right`: lower popularity, then higher id. */
function worseThan(left: QualifiedMovie, right: QualifiedMovie): boolean {
  if (left.popularity !== right.popularity) {
    return left.popularity < right.popularity;
  }

  return left.id > right.id;
}

function siftUp(heap: QualifiedMovie[], index: number): void {
  let current = index;

  while (current > 0) {
    const parent = (current - 1) >> 1;
    const movie = heap[current]!;
    const parentMovie = heap[parent]!;

    if (!worseThan(movie, parentMovie)) {
      return;
    }

    heap[current] = parentMovie;
    heap[parent] = movie;
    current = parent;
  }
}

function siftDown(heap: QualifiedMovie[], index: number): void {
  let current = index;

  while (true) {
    const left = current * 2 + 1;
    const right = left + 1;
    let worst = current;

    if (left < heap.length && worseThan(heap[left]!, heap[worst]!)) {
      worst = left;
    }

    if (right < heap.length && worseThan(heap[right]!, heap[worst]!)) {
      worst = right;
    }

    if (worst === current) {
      return;
    }

    const movie = heap[current]!;
    heap[current] = heap[worst]!;
    heap[worst] = movie;
    current = worst;
  }
}

interface PopularitySelection {
  add(movie: QualifiedMovie): void;
  select(): QualifiedMovie[];
}

/** Keeps the best `limit` movies seen so far in a bounded min-heap. */
function createPopularitySelection(limit: number): PopularitySelection {
  const heap: QualifiedMovie[] = [];

  return {
    add(movie) {
      if (heap.length < limit) {
        heap.push(movie);
        siftUp(heap, heap.length - 1);

        return;
      }

      if (!worseThan(heap[0]!, movie)) {
        return;
      }

      heap[0] = movie;
      siftDown(heap, 0);
    },
    select() {
      return [...heap].sort((left, right) => {
        if (worseThan(left, right)) {
          return 1;
        }

        return worseThan(right, left) ? -1 : 0;
      });
    },
  };
}

export function selectTopByPopularity(
  movies: Iterable<QualifiedMovie>,
  limit: number,
): QualifiedMovie[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid selection limit: ${limit}`);
  }

  const selection = createPopularitySelection(limit);

  for (const movie of movies) {
    selection.add(movie);
  }

  return selection.select();
}

/**
 * Streams a TMDB snapshot and keeps the `limit` most popular rows that are
 * Released, have an overview and a positive runtime. First occurrence wins
 * when an id repeats.
 */
export async function prepareSnapshot(
  source: AsyncIterable<Buffer | string>,
  limit: number = SNAPSHOT_LIMIT,
): Promise<SnapshotResult> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid selection limit: ${limit}`);
  }

  const records = readCsvRecords(source);
  const headerRecord = await records.next();

  if (headerRecord.done === true) {
    throw new Error('CSV is empty');
  }

  const header = headerRecord.value;
  const missing = SNAPSHOT_COLUMNS.filter((column) => !header.includes(column));

  if (missing.length > 0) {
    throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
  }

  const positions = new Map(header.map((column, index) => [column, index]));
  const selection = createPopularitySelection(limit);
  const seen = new Set<number>();
  let rows = 0;
  let invalid = 0;
  let duplicates = 0;

  for await (const record of records) {
    rows += 1;

    const row: Record<string, string> = {};

    for (const column of SNAPSHOT_COLUMNS) {
      const position = positions.get(column) ?? -1;
      row[column] = position === -1 ? '' : (record[position] ?? '');
    }

    const movie = toSnapshotMovie(row);

    if (movie === null) {
      invalid += 1;
      continue;
    }

    if (seen.has(movie.id)) {
      duplicates += 1;
      continue;
    }

    seen.add(movie.id);
    selection.add(movie);
  }

  const selected = selection.select();

  return {
    movies: selected,
    stats: {
      rows,
      invalid,
      duplicates,
      qualified: seen.size,
      selected: selected.length,
    },
  };
}
