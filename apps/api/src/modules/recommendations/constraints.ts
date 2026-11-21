import type { RecommendationFilters } from './types.js';

interface GenreKeyword {
  genre: string;
  pattern: RegExp;
}

// Canonical TMDB genre names as stored in movies.genres. Words are matched on word
// boundaries only, so "thrillingly" does not become Thriller.
const GENRE_KEYWORDS: readonly GenreKeyword[] = [
  { genre: 'Action', pattern: /\baction\b/i },
  { genre: 'Adventure', pattern: /\badventures?\b/i },
  { genre: 'Animation', pattern: /\banimat(?:ion|ed)\b/i },
  { genre: 'Comedy', pattern: /\bcomed(?:y|ies|ic)\b|\bfunny\b/i },
  { genre: 'Crime', pattern: /\bcrimes?\b/i },
  { genre: 'Documentary', pattern: /\bdocumentar(?:y|ies)\b/i },
  { genre: 'Drama', pattern: /\bdramas?\b/i },
  { genre: 'Family', pattern: /\bfamily\b/i },
  { genre: 'Fantasy', pattern: /\bfantas(?:y|ies)\b/i },
  { genre: 'History', pattern: /\bhistor(?:y|ies|ical|ic)\b/i },
  { genre: 'Horror', pattern: /\bhorrors?\b/i },
  { genre: 'Music', pattern: /\bmusic(?:al|als)?\b/i },
  { genre: 'Mystery', pattern: /\bmyster(?:y|ies)\b/i },
  { genre: 'Romance', pattern: /\bromances?\b|\bromantic\b/i },
  { genre: 'Science Fiction', pattern: /\b(?:science[\s-]?fiction|sci[\s-]?fi)\b/i },
  { genre: 'Thriller', pattern: /\bthrillers?\b/i },
  { genre: 'War', pattern: /\bwar\b/i },
  { genre: 'Western', pattern: /\bwesterns?\b/i },
];

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const NUMBER_SOURCE =
  '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

const MAX_DIRECTIONS = new Set([
  'no more than',
  'at most',
  'less than',
  'shorter than',
  'under',
  'below',
  'up to',
  'maximum',
  'max',
]);

interface RuntimeBound {
  minutes: number;
  index: number;
}

const MIN_DECADE_START = 1870;
const MAX_DECADE_START = 2090;

function findGenres(prompt: string): string[] {
  const matches: { genre: string; index: number }[] = [];

  for (const { genre, pattern } of GENRE_KEYWORDS) {
    const match = pattern.exec(prompt);

    if (match !== null) {
      matches.push({ genre, index: match.index });
    }
  }

  // Prompt order keeps the result deterministic; query.ts combines the array with
  // arrayOverlaps, so multiple genres behave as OR (match any), not AND.
  matches.sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return left.genre < right.genre ? -1 : left.genre > right.genre ? 1 : 0;
  });

  return matches.map((match) => match.genre);
}

function twoDigitDecadeStart(value: number): number | undefined {
  if (value === 0) {
    return 2000;
  }

  if (value === 10) {
    return 2010;
  }

  return value >= 20 && value <= 90 ? 1900 + value : undefined;
}

function decadeStart(digits: string): number | undefined {
  const value = Number(digits);
  const start = digits.length === 4 ? value : twoDigitDecadeStart(value);

  if (start === undefined || start % 10 !== 0) {
    return undefined;
  }

  return start >= MIN_DECADE_START && start <= MAX_DECADE_START ? start : undefined;
}

function findDecadeStart(prompt: string): number | undefined {
  // A four-digit decade is preferred by the alternation; "90s" still matches the
  // two-digit branch. Two-digit decades are read as 20th century except 00s/10s.
  const pattern = /\b'?(\d{4}|\d{2})s\b/gi;

  for (const match of prompt.matchAll(pattern)) {
    const digits = match[1];

    if (digits === undefined) {
      continue;
    }

    const start = decadeStart(digits);

    if (start !== undefined) {
      return start;
    }
  }

  return undefined;
}

function runtimeMinutes(numberText: string, unit: string): number | undefined {
  const amount = /^\d/.test(numberText)
    ? Number(numberText)
    : WORD_NUMBERS[numberText.toLowerCase()];

  if (amount === undefined || !Number.isFinite(amount)) {
    return undefined;
  }

  const minutes = Math.round(amount * (unit.toLowerCase().startsWith('h') ? 60 : 1));

  return minutes >= 0 ? minutes : undefined;
}

function findRuntimeBounds(prompt: string): {
  runtimeMin?: number;
  runtimeMax?: number;
} {
  const pattern = new RegExp(
    `\\b(no more than|at most|less than|shorter than|under|below|up to|maximum|max|` +
      `more than|longer than|at least|above|over|minimum|min)\\s+` +
      `(${NUMBER_SOURCE})\\s+(minutes?|mins?|hours?|hrs?|h)\\b`,
    'gi',
  );
  let min: RuntimeBound | undefined;
  let max: RuntimeBound | undefined;

  for (const match of prompt.matchAll(pattern)) {
    const direction = match[1];
    const numberText = match[2];
    const unit = match[3];

    if (direction === undefined || numberText === undefined || unit === undefined) {
      continue;
    }

    const minutes = runtimeMinutes(numberText, unit);

    if (minutes === undefined) {
      continue;
    }

    const bound = { minutes, index: match.index };

    if (MAX_DIRECTIONS.has(direction.toLowerCase())) {
      max ??= bound;
    } else {
      min ??= bound;
    }
  }

  // Contradictory bounds ("under 90 minutes but over 2 hours") keep the bound mentioned
  // first and drop the later one, so the result always passes filter validation.
  if (min !== undefined && max !== undefined && min.minutes > max.minutes) {
    if (min.index > max.index) {
      min = undefined;
    } else {
      max = undefined;
    }
  }

  return {
    ...(min === undefined ? {} : { runtimeMin: min.minutes }),
    ...(max === undefined ? {} : { runtimeMax: max.minutes }),
  };
}

export function parsePromptConstraints(prompt: string): RecommendationFilters | undefined {
  const genres = findGenres(prompt);
  const decade = findDecadeStart(prompt);
  const runtime = findRuntimeBounds(prompt);
  const filters: RecommendationFilters = {};

  if (genres.length > 0) {
    filters.genres = genres;
  }

  if (decade !== undefined) {
    filters.yearMin = decade;
    filters.yearMax = decade + 9;
  }

  if (runtime.runtimeMin !== undefined) {
    filters.runtimeMin = runtime.runtimeMin;
  }

  if (runtime.runtimeMax !== undefined) {
    filters.runtimeMax = runtime.runtimeMax;
  }

  return Object.keys(filters).length === 0 ? undefined : filters;
}
