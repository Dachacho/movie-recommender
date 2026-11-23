import { LETTERBOXD_MAX_CSV_LENGTH } from '@movie-recommender/shared';

/**
 * The API accepts Letterboxd ratings or watches exports and only requires a
 * `Name` column; `Year` is optional. We emit the watches shape because a
 * pasted list is a source for recommendations, not ratings for the profile.
 */
const WATCHES_HEADER = 'Date,Name,Year,Letterboxd URI';

/** Mirrors `MAX_NAME_LENGTH` in the import matcher. */
const MAX_NAME_LENGTH = 200;

const MIN_RELEASE_YEAR = 1870;
const MAX_RELEASE_YEAR = 2100;

export const LIST_PASTE_TOO_LONG_MESSAGE = `That list is too long. Paste at most ${LETTERBOXD_MAX_CSV_LENGTH.toLocaleString('en-US')} characters.`;

/**
 * Formatting adds a header, delimiters, newlines and quoting, so a paste that
 * fits can still emit a CSV request over the import limit. This is the
 * authoritative size failure; the raw-paste check above is only a fast path.
 */
export const LIST_PASTE_CSV_TOO_LONG_MESSAGE =
  'This list is too long after formatting — paste fewer films.';

export type ListPasteResult =
  { ok: true; csv: string; unparseable: string[] } | { ok: false; message: string };

interface ParsedLine {
  title: string;
  year: string;
}

/**
 * A first content line that names both `Name` and `Year` cells is a
 * Letterboxd export header. The paste is then already the CSV shape the import
 * endpoint parses, so it is passed through unchanged instead of being
 * rewritten. Blank lines before the header are dropped because the API expects
 * the header first.
 */
function isLetterboxdHeader(line: string): boolean {
  const cells = line
    .replace(/^\uFEFF/, '')
    .split(',')
    .map((cell) => cell.trim().toLowerCase());

  return cells.includes('name') && cells.includes('year');
}

function validYear(value: string): boolean {
  const year = Number(value);

  return year >= MIN_RELEASE_YEAR && year <= MAX_RELEASE_YEAR;
}

/**
 * Reads the two line formats guests paste most often: `Title (1995)` and
 * `Title, 1995`. A trailing four-digit group that is not a plausible release
 * year stays part of the title rather than becoming an invalid CSV year.
 */
function parseLine(line: string): ParsedLine {
  const closedYear = /^(.*?)\s*\((\d{4})\)\s*$/.exec(line);

  if (closedYear !== null && validYear(closedYear[2] ?? '')) {
    return { title: (closedYear[1] ?? '').trim(), year: closedYear[2] ?? '' };
  }

  const commaYear = /^(.*?),\s*(\d{4})\s*$/.exec(line);

  if (commaYear !== null && validYear(commaYear[2] ?? '')) {
    return { title: (commaYear[1] ?? '').trim(), year: commaYear[2] ?? '' };
  }

  return { title: line.trim(), year: '' };
}

/**
 * The import matcher drops a row whose name is empty, longer than 200
 * characters or contains no letters or digits. Such lines are reported back
 * to the guest instead of being sent as rows the API would only count as
 * invalid.
 */
function isParseableTitle(title: string): boolean {
  return title.length > 0 && title.length <= MAX_NAME_LENGTH && /[\p{L}\p{N}]/u.test(title);
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function csvRow(name: string, year: string): string {
  return `,${escapeCsvField(name)},${year},`;
}

/**
 * Converts pasted list text into the Letterboxd CSV the import endpoint
 * already accepts. No URL is fetched and no network access happens here:
 * this is a pure text conversion. Lines that cannot become a catalog row are
 * returned for the UI to show back; they are guest data and must not be
 * logged.
 */
export function convertListPaste(text: string): ListPasteResult {
  if (text.length > LETTERBOXD_MAX_CSV_LENGTH) {
    return { ok: false, message: LIST_PASTE_TOO_LONG_MESSAGE };
  }

  const lines = text.split(/\r\n|\r|\n/);
  const firstContentLine = lines.find((line) => line.trim() !== '');

  if (firstContentLine !== undefined && isLetterboxdHeader(firstContentLine)) {
    // Keep every byte of the header and its rows; only leading blank lines go.
    return { ok: true, csv: text.slice(text.indexOf(firstContentLine)), unparseable: [] };
  }

  const rows = [WATCHES_HEADER];
  const unparseable: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const { title, year } = parseLine(trimmed);

    if (!isParseableTitle(title)) {
      unparseable.push(trimmed);
      continue;
    }

    rows.push(csvRow(title, year));
  }

  const csv = rows.join('\n');

  if (csv.length > LETTERBOXD_MAX_CSV_LENGTH) {
    return { ok: false, message: LIST_PASTE_CSV_TOO_LONG_MESSAGE };
  }

  return { ok: true, csv, unparseable };
}
