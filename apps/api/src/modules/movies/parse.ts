import type { NewMovie } from '../../db/schema.js';

export interface RawMovieRow {
  [column: string]: string | undefined;
}

export interface Credits {
  director: string | null;
  cast: string[];
}

export interface EmbeddingInput {
  title: string;
  overview: string | null;
  tagline: string | null;
  genres: string[];
  keywords: string[];
}

const NAME_PATTERN = /'name':\s*'((?:\\.|[^'\\])*)'/g;
const DICT_PATTERN = /\{[^{}]*\}/g;

function unescape(value: string): string {
  return value.replace(/\\(['"\\])/g, '$1');
}

export function parseNamedList(raw: string): string[] {
  const names = [...raw.matchAll(NAME_PATTERN)].map((match) => unescape(match[1] ?? '').trim());

  return [...new Set(names.filter((name) => name.length > 0))];
}

export function parseCredits(rawCast: string, rawCrew: string, castLimit: number): Credits {
  const crew = [...rawCrew.matchAll(DICT_PATTERN)].map((match) => match[0]);
  const directorEntry = crew.find((entry) => /'job':\s*'Director'/.test(entry));
  const director = directorEntry === undefined ? null : parseEntryName(directorEntry);

  const cast = [...rawCast.matchAll(DICT_PATTERN)]
    .map((match) => ({
      name: parseEntryName(match[0]),
      order: parseEntryOrder(match[0]),
    }))
    .filter((entry): entry is { name: string; order: number } => entry.name !== null)
    .sort((left, right) => left.order - right.order)
    .slice(0, castLimit)
    .map((entry) => entry.name);

  return { director, cast };
}

function parseEntryName(entry: string): string | null {
  const match = /'name':\s*'((?:\\.|[^'\\])*)'/.exec(entry);

  if (match?.[1] === undefined) {
    return null;
  }

  const name = unescape(match[1]).trim();

  return name.length > 0 ? name : null;
}

function parseEntryOrder(entry: string): number {
  const match = /'order':\s*(\d+)/.exec(entry);

  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  const parsed = parseNumber(value);

  return parsed === null ? null : Math.trunc(parsed);
}

function parseReleaseYear(value: string | undefined): number | null {
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(value?.trim() ?? '');
  const year = match?.[1] === undefined ? null : Number(match[1]);

  return year !== null && year >= 1870 && year <= 2100 ? year : null;
}

function parseRuntime(value: string | undefined): number | null {
  const runtime = parseNumber(value);

  return runtime === null || runtime <= 0 ? null : Math.round(runtime);
}

function parsePosterPath(value: string | undefined): string | null {
  const path = value?.trim() ?? '';

  return path.startsWith('/') ? path : null;
}

export function toNewMovie(
  row: RawMovieRow,
  credits: Credits | undefined,
  keywords: string[],
): NewMovie | null {
  const rawId = (row['id'] ?? '').trim();

  if (!/^\d+$/.test(rawId) || Number(rawId) <= 0) {
    return null;
  }

  if ((row['status'] ?? '').trim() !== 'Released' || (row['adult'] ?? '').trim() === 'True') {
    return null;
  }

  const overview = (row['overview'] ?? '').trim();
  const tagline = (row['tagline'] ?? '').trim();
  const title = (row['title'] ?? '').trim();

  if (title.length === 0 || (overview.length === 0 && keywords.length === 0)) {
    return null;
  }

  return {
    id: Number(rawId),
    title,
    releaseYear: parseReleaseYear(row['release_date']),
    overview: overview.length > 0 ? overview : null,
    tagline: tagline.length > 0 ? tagline : null,
    runtime: parseRuntime(row['runtime']),
    genres: parseNamedList(row['genres'] ?? ''),
    keywords: [
      ...new Set(keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0)),
    ],
    director: credits?.director ?? null,
    cast: credits?.cast ?? [],
    posterPath: parsePosterPath(row['poster_path']),
    popularity: parseNumber(row['popularity']),
    voteAverage: parseNumber(row['vote_average']),
    voteCount: parseInteger(row['vote_count']),
    embedding: null,
    embeddingVersion: null,
  };
}

export function dedupeById<T extends { id: number; voteCount?: number | null | undefined }>(
  rows: T[],
): T[] {
  const byId = new Map<number, T>();

  for (const row of rows) {
    const existing = byId.get(row.id);

    if (existing === undefined || (row.voteCount ?? -1) > (existing.voteCount ?? -1)) {
      byId.set(row.id, row);
    }
  }

  return [...byId.values()];
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
