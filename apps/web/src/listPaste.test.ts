import { LETTERBOXD_MAX_CSV_LENGTH } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import {
  LIST_PASTE_CSV_TOO_LONG_MESSAGE,
  LIST_PASTE_TOO_LONG_MESSAGE,
  convertListPaste,
} from './listPaste';

describe('convertListPaste', () => {
  it('passes a pasted Letterboxd CSV through unchanged when the first line is its header', () => {
    const csv =
      'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,https://letterboxd.com/film/heat/\n';

    expect(convertListPaste(csv)).toEqual({ ok: true, csv, unparseable: [] });
  });

  it('recognizes a lower-case header with a BOM', () => {
    const csv = '\uFEFFdate,name,year,letterboxd uri,rating\n2024-01-01,heat,1995,,\n';

    expect(convertListPaste(csv)).toEqual({ ok: true, csv, unparseable: [] });
  });

  it('keeps a header and its rows when blank lines precede them', () => {
    const csv = 'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,\n';

    expect(convertListPaste(`\n\n${csv}`)).toEqual({ ok: true, csv, unparseable: [] });
  });

  it('converts one-film-per-line titles without a year into watches CSV rows', () => {
    const result = convertListPaste('In the Mood for Love');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,In the Mood for Love,,',
      unparseable: [],
    });
  });

  it('reads a trailing parenthesized year', () => {
    const result = convertListPaste('Heat (1995)');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,Heat,1995,',
      unparseable: [],
    });
  });

  it('reads a trailing comma year', () => {
    const result = convertListPaste('Alien, 1979');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,Alien,1979,',
      unparseable: [],
    });
  });

  it('skips blank lines and handles CRLF line endings', () => {
    const result = convertListPaste('Heat (1995)\r\n\r\n  \r\nAlien\r\n');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,Heat,1995,\n,Alien,,',
      unparseable: [],
    });
  });

  it('quotes names that contain commas or quotes', () => {
    const result = convertListPaste('The Good, the Bad and the Ugly, 1966\nThe "Burbs", 1989');

    expect(result).toEqual({
      ok: true,
      csv:
        'Date,Name,Year,Letterboxd URI\n' +
        ',"The Good, the Bad and the Ugly",1966,\n' +
        ',"The ""Burbs""",1989,',
      unparseable: [],
    });
  });

  it('keeps a comma form as the title when it does not end in a year', () => {
    const result = convertListPaste('Hello, Dolly!');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,"Hello, Dolly!",,',
      unparseable: [],
    });
  });

  it('does not treat a name cell without a literal year column as a header', () => {
    const result = convertListPaste('Name, 1995');

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,Name,1995,',
      unparseable: [],
    });
  });

  it('collects lines that cannot become a catalog name', () => {
    const tooLong = 'x'.repeat(201);
    const result = convertListPaste(`Heat\n${tooLong}\n—\nAlien (1979)`);

    expect(result).toEqual({
      ok: true,
      csv: 'Date,Name,Year,Letterboxd URI\n,Heat,,\n,Alien,1979,',
      unparseable: [tooLong, '—'],
    });
  });

  it('rejects a paste beyond the import request limit', () => {
    expect(convertListPaste('x'.repeat(200_001))).toEqual({
      ok: false,
      message: LIST_PASTE_TOO_LONG_MESSAGE,
    });
  });

  it('accepts a paste exactly at the import request limit', () => {
    const result = convertListPaste('x'.repeat(200_000));

    expect(result.ok).toBe(true);
  });

  it('rejects a paste whose formatted CSV exceeds the import limit', () => {
    // 985 titles of 200 characters: the raw paste fits, but the header,
    // delimiters, newlines and quoting push the CSV past the API limit.
    const pasted = Array.from({ length: 985 }, () => 'x'.repeat(200)).join('\n');

    expect(pasted.length).toBeLessThanOrEqual(LETTERBOXD_MAX_CSV_LENGTH);
    expect(convertListPaste(pasted)).toEqual({
      ok: false,
      message: LIST_PASTE_CSV_TOO_LONG_MESSAGE,
    });
  });

  it('accepts a paste whose formatted CSV is exactly at the import limit', () => {
    // 980 titles of 200 characters plus one 47-character title produce a CSV
    // of exactly 200,000 characters once the header and separators are added.
    const pasted = [...Array.from({ length: 980 }, () => 'x'.repeat(200)), 'x'.repeat(47)].join(
      '\n',
    );
    const result = convertListPaste(pasted);

    expect(pasted.length).toBeLessThanOrEqual(LETTERBOXD_MAX_CSV_LENGTH);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.csv.length).toBe(LETTERBOXD_MAX_CSV_LENGTH);
    }
  });
});
