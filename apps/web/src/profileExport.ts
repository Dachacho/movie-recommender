import type { MovieCard } from '@movie-recommender/shared';
import { z } from 'zod';
import {
  cooldownRecordSchema,
  historyEntrySchema,
  ratingRecordSchema,
  watchedRecordSchema,
  watchlistRecordSchema,
  type CooldownRecord,
  type HistoryEntry,
  type RatingRecord,
  type WatchedRecord,
  type WatchlistRecord,
} from './profile/schema';

export interface CsvRatingRow {
  /** YYYY-MM-DD, UTC. */
  ratedOn: string;
  title: string;
  releaseYear: number | null;
  /** 0.5..5 half-stars. */
  rating: number;
}

const LETTERBOXD_CSV_HEADER = 'Date,Name,Year,Letterboxd URI,Rating';

const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Deliberate: spreadsheet apps execute a cell that starts with one of these
 * characters even when the CSV field is quoted. The leading apostrophe keeps
 * the cell literal. Letterboxd's importer will see that apostrophe for such
 * titles; that is the accepted trade-off, formula safety over matching a
 * handful of pathological titles. Only the free-text title needs this.
 */
function sanitizeCsvTitle(title: string): string {
  if (FORMULA_INJECTION_PREFIXES.has(title.charAt(0))) {
    return `'${title}`;
  }

  return title;
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function csvRow(row: CsvRatingRow): string {
  const year = row.releaseYear === null ? '' : `${row.releaseYear}`;

  return [row.ratedOn, escapeCsvField(sanitizeCsvTitle(row.title)), year, '', `${row.rating}`].join(
    ',',
  );
}

/** Formats a timestamp as its UTC calendar date, regardless of the local zone. */
export function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Builds Letterboxd's ratings export format. The URI column stays empty
 * because these ratings come from the guest profile, not a Letterboxd diary.
 */
export function buildLetterboxdCsv(rows: readonly CsvRatingRow[]): string {
  return [LETTERBOXD_CSV_HEADER, ...rows.map(csvRow)].join('\n');
}

/**
 * Resolves stored ratings into export rows, newest first. A row whose movie is
 * no longer in the catalog is reported through `skipped` instead of being
 * emitted with invented metadata.
 */
export function ratingRowsForExport(
  ratings: readonly RatingRecord[],
  cards: ReadonlyMap<number, MovieCard | null>,
): { rows: CsvRatingRow[]; skipped: number } {
  const newestById = new Map<number, RatingRecord>();

  for (const record of ratings) {
    const existing = newestById.get(record.movieId);

    if (existing === undefined || record.updatedAt > existing.updatedAt) {
      newestById.set(record.movieId, record);
    }
  }

  const rows: CsvRatingRow[] = [];
  let skipped = 0;

  const newest = [...newestById.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.movieId - left.movieId,
  );

  for (const record of newest) {
    const card = cards.get(record.movieId);

    if (card === undefined || card === null) {
      skipped += 1;
      continue;
    }

    rows.push({
      ratedOn: isoDate(record.updatedAt),
      title: card.title,
      releaseYear: card.releaseYear,
      rating: record.rating,
    });
  }

  return { rows, skipped };
}

export const PROFILE_BACKUP_VERSION = 1;

export interface ProfileBackupInput {
  ratings: readonly RatingRecord[];
  watched: readonly WatchedRecord[];
  watchlist: readonly WatchlistRecord[];
  cooldowns: readonly CooldownRecord[];
  history: readonly HistoryEntry[];
}

export interface ProfileBackup {
  version: typeof PROFILE_BACKUP_VERSION;
  exportedAt: string;
  ratings: RatingRecord[];
  watched: WatchedRecord[];
  watchlist: WatchlistRecord[];
  cooldowns: CooldownRecord[];
  history: HistoryEntry[];
}

const profileBackupSchema = z.object({
  version: z.literal(PROFILE_BACKUP_VERSION),
  exportedAt: z.iso.datetime(),
  ratings: z.array(ratingRecordSchema),
  watched: z.array(watchedRecordSchema),
  watchlist: z.array(watchlistRecordSchema),
  cooldowns: z.array(cooldownRecordSchema),
  history: z.array(historyEntrySchema),
});

export class ProfileBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileBackupError';
  }
}

/** Serializes every guest-owned row as a versioned JSON backup. */
export function buildProfileBackup(input: ProfileBackupInput, exportedAt: number): string {
  const backup: ProfileBackup = {
    version: PROFILE_BACKUP_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    ratings: [...input.ratings],
    watched: [...input.watched],
    watchlist: [...input.watchlist],
    cooldowns: [...input.cooldowns],
    history: [...input.history],
  };

  return JSON.stringify(backup, null, 2);
}

/**
 * Parses a backup file at the guest boundary. Everything is validated before
 * any row is handed to storage, so a malformed file cannot partially import.
 */
export function parseProfileBackup(json: string): ProfileBackup {
  let payload: unknown;

  try {
    payload = JSON.parse(json) as unknown;
  } catch {
    throw new ProfileBackupError('The profile backup is not valid JSON.');
  }

  const parsed = profileBackupSchema.safeParse(payload);

  if (!parsed.success) {
    throw new ProfileBackupError(
      parsed.error.issues[0]?.message ?? 'The profile backup has an unexpected shape.',
    );
  }

  return parsed.data;
}
