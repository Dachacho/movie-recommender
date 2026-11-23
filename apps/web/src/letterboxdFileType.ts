export type LetterboxdFileMode = 'ratings' | 'watched' | 'watchlist';

/**
 * Detect which Letterboxd export a guest chose.
 *
 * A `Rating` column always means ratings. Real watches.csv and watchlist.csv
 * exports share the identical header `Date,Name,Year,Letterboxd URI`, so the
 * header alone cannot tell them apart: the original filename is the only
 * disambiguator (`watchlist` in its lowercased basename). Without that name the
 * import falls back to watches, which marks films watched. The older
 * `Position,Name,Year,...` watchlist shape is still accepted when present.
 *
 * Header parsing tolerates a byte-order mark, surrounding whitespace, quoted
 * cells and any casing. Anything unrecognised falls back to watches; the API
 * then rejects the file if it has no `Name` column, and nothing is mapped.
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

export function detectLetterboxdFileType(csv: string, filename?: string): LetterboxdFileMode {
  const cells = headerCells(csv);

  if (cells.includes('rating')) {
    return 'ratings';
  }

  if (cells.includes('position')) {
    return 'watchlist';
  }

  if (filename !== undefined && filename.toLowerCase().includes('watchlist')) {
    return 'watchlist';
  }

  return 'watched';
}
