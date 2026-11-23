import { describe, expect, it } from 'vitest';
import {
  LetterboxdCsvError,
  MAX_IMPORT_ROWS,
  indexCatalogCandidates,
  matchLetterboxdRows,
  normalizeTitle,
  parseLetterboxdCsv,
  pickCatalogCandidate,
  type CatalogCandidate,
  type LetterboxdRow,
} from './match.js';

function row(overrides: Partial<LetterboxdRow> & Pick<LetterboxdRow, 'name'>): LetterboxdRow {
  return {
    normalizedTitle: normalizeTitle(overrides.name),
    year: null,
    rating: null,
    ...overrides,
  };
}

function candidate(movieId: number, title: string, releaseYear: number | null): CatalogCandidate {
  return { movieId, title, releaseYear };
}

const RATINGS_HEADER = 'Date,Name,Year,Letterboxd URI,Rating\n';
const WATCHES_HEADER = 'Date,Name,Year,Letterboxd URI\n';

describe('normalizeTitle', () => {
  it('trims and lowercases', () => {
    expect(normalizeTitle('  The Matrix  ')).toBe('the matrix');
  });

  it('collapses punctuation and whitespace into single spaces', () => {
    expect(normalizeTitle('Spider-Man:  No  Way Home!!')).toBe('spider man no way home');
  });

  it('drops ampersands and keeps the remaining words', () => {
    expect(normalizeTitle('Fast & Furious')).toBe('fast furious');
  });

  it('treats typographic apostrophes like plain punctuation', () => {
    expect(normalizeTitle('Schindler’s List')).toBe('schindler s list');
  });

  it('does not strip accents', () => {
    expect(normalizeTitle('Amélie')).toBe('amélie');
  });

  it('returns an empty string for punctuation-only titles', () => {
    expect(normalizeTitle(' ... ')).toBe('');
  });
});

describe('parseLetterboxdCsv', () => {
  it('parses a ratings export with names containing commas and quotes', () => {
    const csv = `${RATINGS_HEADER}2026-01-01,"Hello, ""World""",1999,https://boxd.it/abc,4.5\n`;

    const parsed = parseLetterboxdCsv(csv);

    expect(parsed.invalid).toBe(0);
    expect(parsed.rows).toEqual([
      {
        name: 'Hello, "World"',
        normalizedTitle: 'hello world',
        year: 1999,
        rating: 4.5,
      },
    ]);
  });

  it('parses a watches export without a Rating column as watched-only rows', () => {
    const csv = `${WATCHES_HEADER}2026-01-01,Heat,1995,https://boxd.it/def\n`;

    const parsed = parseLetterboxdCsv(csv);

    expect(parsed.invalid).toBe(0);
    expect(parsed.rows).toEqual([
      { name: 'Heat', normalizedTitle: 'heat', year: 1995, rating: null },
    ]);
  });

  it('parses a watchlist export with a Position column and no Rating', () => {
    const csv = 'Position,Name,Year,Letterboxd URI\n1,Heat,1995,https://boxd.it/def\n';

    const parsed = parseLetterboxdCsv(csv);

    expect(parsed.invalid).toBe(0);
    expect(parsed.rows).toEqual([
      { name: 'Heat', normalizedTitle: 'heat', year: 1995, rating: null },
    ]);
  });

  it('treats a blank year or rating as null', () => {
    const csv = `${RATINGS_HEADER}2026-01-01,Up,,,\n`;

    expect(parseLetterboxdCsv(csv).rows[0]).toEqual({
      name: 'Up',
      normalizedTitle: 'up',
      year: null,
      rating: null,
    });
  });

  it.each(['3.25', '0', '6', 'abc', '-1', '4,5'])(
    'counts a row with invalid rating %s as invalid',
    (rating) => {
      const csv = `${RATINGS_HEADER}2026-01-01,Heat,1995,,${rating}\n`;

      expect(parseLetterboxdCsv(csv)).toEqual({ rows: [], invalid: 1 });
    },
  );

  it.each(['abcd', '1499', '2101', '1995.5'])(
    'counts a row with invalid year %s as invalid',
    (year) => {
      const csv = `${RATINGS_HEADER}2026-01-01,Heat,${year},,\n`;

      expect(parseLetterboxdCsv(csv)).toEqual({ rows: [], invalid: 1 });
    },
  );

  it('counts an empty name, an over-long name and a punctuation-only name as invalid', () => {
    const overLongName = 'a'.repeat(201);
    const csv =
      `${RATINGS_HEADER}` +
      `2026-01-01,,1995,,\n` +
      `2026-01-02,${overLongName},1995,,\n` +
      `2026-01-03,...,1995,,\n`;

    expect(parseLetterboxdCsv(csv)).toEqual({ rows: [], invalid: 3 });
  });

  it('counts a row with more fields than the header as invalid', () => {
    const csv = `${RATINGS_HEADER}2026-01-01,Heat,1995,,4.5,extra\n`;

    expect(parseLetterboxdCsv(csv)).toEqual({ rows: [], invalid: 1 });
  });

  it('keeps valid rows while counting invalid ones', () => {
    const csv =
      `${RATINGS_HEADER}` + `2026-01-01,Heat,1995,,4.5\n` + `2026-01-02,Broken,1995,,nope\n`;

    const parsed = parseLetterboxdCsv(csv);

    expect(parsed.invalid).toBe(1);
    expect(parsed.rows.map((entry) => entry.name)).toEqual(['Heat']);
  });

  it('accepts a byte-order mark and header whitespace variants', () => {
    const csv = '\uFEFFDate, Name ,Year,Letterboxd URI, Rating\n2026-01-01,Heat,1995,,4\n';

    expect(parseLetterboxdCsv(csv).rows.map((entry) => entry.name)).toEqual(['Heat']);
  });

  it('returns no rows for a header-only export', () => {
    expect(parseLetterboxdCsv(RATINGS_HEADER)).toEqual({ rows: [], invalid: 0 });
  });

  it('accepts exactly the maximum number of rows', () => {
    const csv = `${WATCHES_HEADER}${`2026-01-01,Heat,1995,\n`.repeat(MAX_IMPORT_ROWS)}`;

    expect(parseLetterboxdCsv(csv).rows).toHaveLength(MAX_IMPORT_ROWS);
  });

  it('rejects an export above the row cap', () => {
    const csv = `${WATCHES_HEADER}${`2026-01-01,Heat,1995,\n`.repeat(MAX_IMPORT_ROWS + 1)}`;

    expect(() => parseLetterboxdCsv(csv)).toThrow(LetterboxdCsvError);
  });

  it('rejects an empty CSV', () => {
    expect(() => parseLetterboxdCsv('')).toThrow(LetterboxdCsvError);
  });

  it('rejects a CSV without a Name column', () => {
    const csv = 'Date,Year,Rating\n2026-01-01,1995,4\n';

    expect(() => parseLetterboxdCsv(csv)).toThrow(LetterboxdCsvError);
  });

  it('rejects an unterminated quoted field as a Letterboxd CSV error', () => {
    const csv = `${RATINGS_HEADER}2026-01-01,"Unclosed`;

    expect(() => parseLetterboxdCsv(csv)).toThrow(LetterboxdCsvError);
  });
});

describe('pickCatalogCandidate', () => {
  it('matches the same title in a different case and punctuation style', () => {
    const index = indexCatalogCandidates([candidate(10, 'Spider-Man: No Way Home', 2021)]);

    expect(
      pickCatalogCandidate(row({ name: 'spider man no way home', year: 2021 }), index),
    ).toEqual(candidate(10, 'Spider-Man: No Way Home', 2021));
  });

  it('accepts a year off by one in either direction', () => {
    const index = indexCatalogCandidates([candidate(10, 'Heat', 1995)]);

    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1994 }), index)?.movieId).toBe(10);
    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1996 }), index)?.movieId).toBe(10);
  });

  it('rejects a year difference of two or more', () => {
    const index = indexCatalogCandidates([candidate(10, 'Heat', 1995)]);

    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1993 }), index)).toBeNull();
    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1997 }), index)).toBeNull();
  });

  it('matches by title alone when the row has no year', () => {
    const index = indexCatalogCandidates([
      candidate(30, 'Heat', 1995),
      candidate(20, 'Heat', 1986),
    ]);

    expect(pickCatalogCandidate(row({ name: 'Heat' }), index)?.movieId).toBe(20);
  });

  it('does not match a catalog row without a year when the import row has one', () => {
    const index = indexCatalogCandidates([candidate(10, 'Heat', null)]);

    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1995 }), index)).toBeNull();
  });

  it('prefers an exact year over a one-year difference', () => {
    const index = indexCatalogCandidates([
      candidate(10, 'Heat', 1996),
      candidate(20, 'Heat', 1995),
    ]);

    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1995 }), index)?.movieId).toBe(20);
  });

  it('breaks equal year differences with the lowest movie id', () => {
    const index = indexCatalogCandidates([
      candidate(30, 'Heat', 1996),
      candidate(10, 'Heat', 1994),
      candidate(20, 'Heat', 1995),
    ]);

    // 10 and 30 are both one year away; the smaller id wins.
    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1995 }), index)?.movieId).toBe(20);

    const withoutExact = indexCatalogCandidates([
      candidate(30, 'Heat', 1996),
      candidate(10, 'Heat', 1994),
    ]);

    expect(pickCatalogCandidate(row({ name: 'Heat', year: 1995 }), withoutExact)?.movieId).toBe(10);
  });

  it('returns null when the title is absent from the catalog', () => {
    const index = indexCatalogCandidates([candidate(10, 'Heat', 1995)]);

    expect(pickCatalogCandidate(row({ name: 'Unknown Film', year: 2020 }), index)).toBeNull();
  });
});

describe('matchLetterboxdRows', () => {
  const index = indexCatalogCandidates([
    candidate(1, 'The Matrix', 1999),
    candidate(2, 'Heat', 1995),
    candidate(3, 'Spider-Man: No Way Home', 2021),
  ]);

  it('reports matched rows with their rating and unmatched rows with a reason', () => {
    const report = matchLetterboxdRows(
      [
        row({ name: 'The Matrix', year: 1999, rating: 4.5 }),
        row({ name: 'Unknown Film', year: 2020 }),
      ],
      index,
    );

    expect(report).toEqual({
      matched: [{ movieId: 1, title: 'The Matrix', releaseYear: 1999, rating: 4.5 }],
      unmatched: [{ name: 'Unknown Film', year: 2020, reason: 'no_match' }],
    });
  });

  it('keeps a matched watched-only row with a null rating', () => {
    const report = matchLetterboxdRows([row({ name: 'The Matrix', year: 1999 })], index);

    expect(report.matched).toEqual([
      { movieId: 1, title: 'The Matrix', releaseYear: 1999, rating: null },
    ]);
  });

  it('lets the last duplicate row win for the same film', () => {
    const report = matchLetterboxdRows(
      [
        row({ name: 'Heat', year: 1995, rating: 2 }),
        row({ name: 'the matrix', year: 1999, rating: 3 }),
        row({ name: 'Heat', year: 1995, rating: 5 }),
      ],
      index,
    );

    expect(report.matched).toEqual([
      { movieId: 2, title: 'Heat', releaseYear: 1995, rating: 5 },
      { movieId: 1, title: 'The Matrix', releaseYear: 1999, rating: 3 },
    ]);
  });

  it('collapses rows that resolve to the same film through the year tolerance', () => {
    const report = matchLetterboxdRows(
      [row({ name: 'Heat', year: 1995, rating: 2 }), row({ name: 'Heat', year: 1996, rating: 4 })],
      index,
    );

    expect(report.matched).toEqual([{ movieId: 2, title: 'Heat', releaseYear: 1995, rating: 4 }]);
  });

  it('reports duplicate unmatched rows once, keeping the first position and last name', () => {
    const report = matchLetterboxdRows(
      [
        row({ name: 'Unknown Film', year: 2020 }),
        row({ name: 'Other Unknown', year: 2021 }),
        row({ name: 'UNKNOWN FILM', year: 2020 }),
      ],
      index,
    );

    expect(report.matched).toEqual([]);
    expect(report.unmatched).toEqual([
      { name: 'UNKNOWN FILM', year: 2020, reason: 'no_match' },
      { name: 'Other Unknown', year: 2021, reason: 'no_match' },
    ]);
  });

  it('keeps unmatched rows with the same title in different years separate', () => {
    const report = matchLetterboxdRows(
      [row({ name: 'Unknown Film', year: 2020 }), row({ name: 'Unknown Film', year: 1990 })],
      index,
    );

    expect(report.unmatched).toHaveLength(2);
    expect(report.unmatched.map((entry) => entry.year)).toEqual([2020, 1990]);
  });
});
