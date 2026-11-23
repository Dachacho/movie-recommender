import { describe, expect, it } from 'vitest';
import { detectLetterboxdFileType } from './letterboxdFileType';

const RATINGS_ROW = '2024-01-01,Heat,1995,https://letterboxd.com/film/heat/,4.5';
const WATCHES_ROW = '2024-01-01,Heat,1995,https://letterboxd.com/film/heat/';
const WATCHLIST_ROW = '1,Heat,1995,https://letterboxd.com/film/heat/';

describe('detectLetterboxdFileType', () => {
  it('detects a ratings export from its Rating column', () => {
    const csv = `Date,Name,Year,Letterboxd URI,Rating\n${RATINGS_ROW}\n`;

    expect(detectLetterboxdFileType(csv)).toBe('ratings');
  });

  it('detects a watches export from its Date/Name/Year header', () => {
    const csv = `Date,Name,Year,Letterboxd URI\n${WATCHES_ROW}\n`;

    expect(detectLetterboxdFileType(csv)).toBe('watched');
  });

  it('detects a watchlist export from its Position column', () => {
    const csv = `Position,Name,Year,Letterboxd URI\n${WATCHLIST_ROW}\n`;

    expect(detectLetterboxdFileType(csv)).toBe('watchlist');
  });

  it('prefers ratings when a header carries both Rating and Position', () => {
    const csv = `Position,Name,Year,Letterboxd URI,Rating\n${WATCHLIST_ROW},4.5\n`;

    expect(detectLetterboxdFileType(csv)).toBe('ratings');
  });

  it('ignores case, surrounding whitespace and a byte-order mark', () => {
    const ratings = `\uFEFFdate, name ,year,letterboxd uri,rAtInG\n${RATINGS_ROW}\n`;
    const watchlist = `\uFEFFposition,name,year,letterboxd uri\n${WATCHLIST_ROW}\n`;

    expect(detectLetterboxdFileType(ratings)).toBe('ratings');
    expect(detectLetterboxdFileType(watchlist)).toBe('watchlist');
  });

  it('falls back to the watches shape when the header has neither column', () => {
    expect(detectLetterboxdFileType('Name,Year\nHeat,1995\n')).toBe('watched');
    expect(detectLetterboxdFileType('')).toBe('watched');
  });
});
