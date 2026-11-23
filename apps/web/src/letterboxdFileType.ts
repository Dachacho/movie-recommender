export type LetterboxdFileMode = 'ratings' | 'watched' | 'watchlist';

/**
 * Letterboxd export files share three shapes and their filenames are not a
 * reliable signal (guests rename them and every export is called csv). The
 * header is:
 *
 * - ratings.csv:   `Date,Name,Year,Letterboxd URI,Rating`
 * - watches.csv:   `Date,Name,Year,Letterboxd URI`
 * - watchlist.csv: `Position,Name,Year,Letterboxd URI`
 *
 * Tolerates the same header noise as the API: a byte-order mark, surrounding
 * whitespace, quoted cells and any casing. `Rating` wins over `Position` so a
 * ratings export that somehow carries both is never treated as a watchlist.
 * Anything unrecognised falls back to the watches shape; the API then rejects
 * the file if it has no `Name` column, and nothing is mapped.
 */
function headerCells(csv: string): string[] {
  const headerLine = csv.split(/\r\n|\r|\n/, 1)[0] ?? '';

  return headerLine.split(',').map((cell) =>
    cell
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase(),
  );
}

export function detectLetterboxdFileType(csv: string): LetterboxdFileMode {
  const cells = headerCells(csv);

  if (cells.includes('rating')) {
    return 'ratings';
  }

  if (cells.includes('position')) {
    return 'watchlist';
  }

  return 'watched';
}
