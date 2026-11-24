import type { MovieCard } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import type { RatingRecord } from './profile/schema';
import {
  PROFILE_BACKUP_VERSION,
  ProfileBackupError,
  buildLetterboxdCsv,
  buildProfileBackup,
  isoDate,
  parseProfileBackup,
  ratingRowsForExport,
  type CsvRatingRow,
  type ProfileBackupInput,
} from './profileExport';

function movieCard(id: number, overrides: Partial<MovieCard> = {}): MovieCard {
  return {
    id,
    title: `Movie ${id}`,
    releaseYear: 2000,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
    ...overrides,
  };
}

const HEADER = 'Date,Name,Year,Letterboxd URI,Rating';

function csvRow(overrides: Partial<CsvRatingRow> = {}): CsvRatingRow {
  return {
    ratedOn: '2024-01-01',
    title: 'Arrival',
    releaseYear: 2016,
    rating: 4.5,
    ...overrides,
  };
}

function backupInput(): ProfileBackupInput {
  return {
    ratings: [{ movieId: 1, rating: 4.5, updatedAt: 1_700_000_000_000 }],
    watched: [{ movieId: 2, watchedAt: 1_700_000_000_001 }],
    watchlist: [{ movieId: 3, addedAt: 1_700_000_000_002 }],
    cooldowns: [{ movieId: 4, expiresAt: 1_700_000_000_003 }],
    history: [
      {
        id: 1,
        createdAt: 1_700_000_000_004,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [{ id: 5, title: 'Movie 5', releaseYear: 2000, posterPath: null }],
      },
    ],
  };
}

const EXPORTED_AT = Date.UTC(2024, 0, 2, 3, 4, 5);

function backupPayload(): Record<string, unknown> {
  return JSON.parse(buildProfileBackup(backupInput(), EXPORTED_AT)) as Record<string, unknown>;
}

describe('isoDate', () => {
  it('formats a timestamp as its UTC calendar date', () => {
    expect(isoDate(Date.UTC(2024, 4, 20, 12, 0, 0))).toBe('2024-05-20');
  });

  it('uses the UTC date when the local date differs', () => {
    const offsetMinutes = new Date(Date.UTC(2024, 0, 1, 12)).getTimezoneOffset();
    // Pick an instant that lands on the neighbouring day in any non-UTC zone.
    const timestamp = Date.UTC(2024, 0, 1, offsetMinutes > 0 ? 1 : 23, 30);
    const local = new Date(timestamp);
    const localDate = [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, '0'),
      String(local.getDate()).padStart(2, '0'),
    ].join('-');

    expect(localDate === '2024-01-01').toBe(offsetMinutes === 0);
    expect(isoDate(timestamp)).toBe('2024-01-01');
  });
});

describe('buildLetterboxdCsv', () => {
  it('emits only the header when there are no rows', () => {
    expect(buildLetterboxdCsv([])).toBe(HEADER);
  });

  it('writes the Letterboxd ratings header and plain decimal ratings', () => {
    const csv = buildLetterboxdCsv([
      csvRow({ ratedOn: '2024-05-20', title: 'Arrival', releaseYear: 2016, rating: 4.5 }),
      csvRow({ ratedOn: '2024-05-19', title: 'Unknown Year', releaseYear: null, rating: 4 }),
    ]);

    expect(csv).toBe(
      [HEADER, '2024-05-20,Arrival,2016,,4.5', '2024-05-19,Unknown Year,,,4'].join('\n'),
    );
  });

  it('quotes a title containing a comma', () => {
    const csv = buildLetterboxdCsv([csvRow({ title: 'Dune, Part Two' })]);

    expect(csv.split('\n')[1]).toBe('2024-01-01,"Dune, Part Two",2016,,4.5');
  });

  it('doubles internal quotes', () => {
    const csv = buildLetterboxdCsv([csvRow({ title: 'The "Burbs"' })]);

    expect(csv.split('\n')[1]).toBe('2024-01-01,"The ""Burbs""",2016,,4.5');
  });

  it('quotes a title containing a newline or carriage return', () => {
    const csv = buildLetterboxdCsv([csvRow({ title: 'Line\nBreak' })]);

    expect(csv).toBe(`${HEADER}\n2024-01-01,"Line\nBreak",2016,,4.5`);

    const carriageReturnCsv = buildLetterboxdCsv([csvRow({ title: 'Line\rBreak' })]);

    expect(carriageReturnCsv).toBe(`${HEADER}\n2024-01-01,"Line\rBreak",2016,,4.5`);
  });

  const FORMULA_PREFIX_CASES: readonly { label: string; title: string; field: string }[] = [
    { label: 'equals', title: '=SUM(A1,A2)', field: `"'=SUM(A1,A2)"` },
    { label: 'plus', title: '+1,000', field: `"'+1,000"` },
    { label: 'minus', title: '-1,000', field: `"'-1,000"` },
    { label: 'at', title: '@home, now', field: `"'@home, now"` },
    { label: 'tab', title: '\tTabbed, value', field: `"'\tTabbed, value"` },
    { label: 'carriage return', title: '\rCarriage', field: `"'\rCarriage"` },
  ];

  it.each(FORMULA_PREFIX_CASES)(
    'prefixes an apostrophe for a title beginning with $label',
    ({ title, field }) => {
      const csv = buildLetterboxdCsv([csvRow({ title })]);

      expect(csv).toBe(`${HEADER}\n2024-01-01,${field},2016,,4.5`);
    },
  );

  it('applies the apostrophe and quote escaping together', () => {
    const csv = buildLetterboxdCsv([csvRow({ title: '="quoted"' })]);

    expect(csv.split('\n')[1]).toBe('2024-01-01,"\'=""quoted""",2016,,4.5');
  });

  it('leaves an ordinary title unchanged', () => {
    const csv = buildLetterboxdCsv([csvRow({ title: 'Arrival' })]);

    expect(csv.split('\n')[1]).toBe('2024-01-01,Arrival,2016,,4.5');
  });
});

describe('ratingRowsForExport', () => {
  it('collapses duplicate ratings to the newest and sorts newest first', () => {
    const ratings: RatingRecord[] = [
      { movieId: 10, rating: 3, updatedAt: Date.UTC(2024, 0, 1) },
      { movieId: 10, rating: 4.5, updatedAt: Date.UTC(2024, 0, 3) },
      { movieId: 20, rating: 2, updatedAt: Date.UTC(2024, 0, 2) },
      { movieId: 30, rating: 5, updatedAt: Date.UTC(2024, 0, 4) },
      { movieId: 40, rating: 1, updatedAt: Date.UTC(2024, 0, 5) },
    ];
    const cards = new Map<number, MovieCard | null>([
      [10, movieCard(10, { title: 'Ten', releaseYear: 2010 })],
      [20, movieCard(20, { title: 'Twenty', releaseYear: null })],
      [40, null],
    ]);

    const { rows, skipped } = ratingRowsForExport(ratings, cards);

    expect(rows).toEqual([
      { ratedOn: '2024-01-03', title: 'Ten', releaseYear: 2010, rating: 4.5 },
      { ratedOn: '2024-01-02', title: 'Twenty', releaseYear: null, rating: 2 },
    ]);
    expect(skipped).toBe(2);
  });

  it('breaks updatedAt ties by the higher movie id first', () => {
    const updatedAt = Date.UTC(2024, 0, 1);
    const cards = new Map<number, MovieCard | null>([
      [7, movieCard(7)],
      [9, movieCard(9)],
    ]);

    const { rows, skipped } = ratingRowsForExport(
      [
        { movieId: 7, rating: 3, updatedAt },
        { movieId: 9, rating: 4, updatedAt },
      ],
      cards,
    );

    expect(rows.map((row) => row.title)).toEqual(['Movie 9', 'Movie 7']);
    expect(skipped).toBe(0);
  });

  it('returns no rows when there are no ratings', () => {
    expect(ratingRowsForExport([], new Map())).toEqual({ rows: [], skipped: 0 });
  });
});

describe('profile backup', () => {
  it('round-trips every typed row through build and parse', () => {
    const input = backupInput();

    const backup = parseProfileBackup(buildProfileBackup(input, EXPORTED_AT));

    expect(backup).toEqual({
      version: 1,
      exportedAt: '2024-01-02T03:04:05.000Z',
      ratings: input.ratings,
      watched: input.watched,
      watchlist: input.watchlist,
      cooldowns: input.cooldowns,
      history: input.history,
    });
  });

  it('writes the version and an ISO export timestamp with two-space indentation', () => {
    const json = buildProfileBackup(backupInput(), EXPORTED_AT);

    expect(PROFILE_BACKUP_VERSION).toBe(1);
    expect(json).toContain('\n  "version": 1,');
    expect(json).toContain('\n  "exportedAt": "2024-01-02T03:04:05.000Z",');
  });

  it('rejects a backup with the wrong version', () => {
    const payload = { ...backupPayload(), version: 2 };

    expect(() => parseProfileBackup(JSON.stringify(payload))).toThrow(ProfileBackupError);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseProfileBackup('{"version":1,')).toThrow(ProfileBackupError);
  });

  it('rejects an invalid rating row', () => {
    const payload = backupPayload();
    payload.ratings = [{ movieId: 1, rating: 6, updatedAt: 1 }];

    expect(() => parseProfileBackup(JSON.stringify(payload))).toThrow(ProfileBackupError);
  });

  it('rejects an invalid watched row', () => {
    const payload = backupPayload();
    payload.watched = [{ movieId: 0, watchedAt: 1 }];

    expect(() => parseProfileBackup(JSON.stringify(payload))).toThrow(ProfileBackupError);
  });
});
