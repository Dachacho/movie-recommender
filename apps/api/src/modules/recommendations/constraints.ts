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
  { genre: 'Comedy', pattern: /\bcomed(?:y|ies|ic)\b|\bfunny\b|\blight[\s-]?hearted\b/i },
  { genre: 'Crime', pattern: /\bcrimes?\b/i },
  { genre: 'Documentary', pattern: /\bdocumentar(?:y|ies)\b/i },
  { genre: 'Drama', pattern: /\bdramas?\b/i },
  { genre: 'Family', pattern: /\bfamily\b/i },
  { genre: 'Fantasy', pattern: /\bfantas(?:y|ies)\b/i },
  { genre: 'History', pattern: /\bhistor(?:y|ies|ical|ic)\b/i },
  { genre: 'Horror', pattern: /\bhorrors?\b|\bscary\b|\bfrightening\b/i },
  { genre: 'Music', pattern: /\bmusic(?:al|als)?\b/i },
  { genre: 'Mystery', pattern: /\bmyster(?:y|ies)\b/i },
  { genre: 'Romance', pattern: /\bromances?\b|\bromantic\b/i },
  { genre: 'Science Fiction', pattern: /\b(?:science[\s-]?fiction|sci[\s-]?fi)\b/i },
  { genre: 'Thriller', pattern: /\bthrillers?\b/i },
  { genre: 'War', pattern: /\bwar\b/i },
  { genre: 'Western', pattern: /\bwesterns?\b/i },
];

const ROM_COM_PATTERN = /\brom-?coms?\b/i;
const ROM_COM_GENRES = ['Comedy', 'Romance'] as const;

// A genre preceded by a negation is not a positive request. Only the current
// clause counts: a contrastive conjunction or punctuation resets the window, so
// "not horror but comedy" keeps Comedy. The window is three words, short enough
// that "no longer than 2 hours thriller" does not suppress Thriller.
const NEGATION_WORDS = new Set([
  'not',
  'no',
  'without',
  'except',
  'excluding',
  "don't",
  'dont',
  "didn't",
  'didnt',
  "doesn't",
  'doesnt',
  "wouldn't",
  'wouldnt',
  "won't",
  'wont',
]);
const NEGATION_WINDOW = 3;
const CLAUSE_BREAK_PATTERN = /\b(?:but|however|yet|instead|rather)\b|[.,;!?]/gi;
// "not only X" includes X; "anything but X" and "all but X" exclude X.
const NOT_ONLY_PATTERN = /\bnot\s+only\s+(?:(?:a|an|the|any|just|merely)\s+)*$/i;
const ANYTHING_BUT_PATTERN = /\b(?:anything|all)\s+but\s+(?:(?:a|an|the|any)\s+)*$/i;

function isNegated(prompt: string, index: number): boolean {
  const before = prompt.slice(0, index).toLowerCase().replaceAll('\u2019', "'");

  if (NOT_ONLY_PATTERN.test(before)) {
    return false;
  }

  if (ANYTHING_BUT_PATTERN.test(before)) {
    return true;
  }

  let clauseStart = 0;

  for (const match of before.matchAll(CLAUSE_BREAK_PATTERN)) {
    if (match.index !== undefined) {
      clauseStart = match.index + match[0].length;
    }
  }

  const words = before.slice(clauseStart).match(/[a-z']+/g) ?? [];

  return words.slice(-NEGATION_WINDOW).some((word) => NEGATION_WORDS.has(word));
}

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
  'no longer than',
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
  const indexByGenre = new Map<string, number>();

  function addGenre(genre: string, index: number): void {
    const current = indexByGenre.get(genre);

    // Keep the first mention; a later duplicate must not move the genre or
    // duplicate it in the filter array.
    if (current === undefined || index < current) {
      indexByGenre.set(genre, index);
    }
  }

  const romCom = ROM_COM_PATTERN.exec(prompt);

  if (romCom !== null && !isNegated(prompt, romCom.index)) {
    for (const genre of ROM_COM_GENRES) {
      addGenre(genre, romCom.index);
    }
  }

  for (const { genre, pattern } of GENRE_KEYWORDS) {
    const match = pattern.exec(prompt);

    if (match !== null && !isNegated(prompt, match.index)) {
      addGenre(genre, match.index);
    }
  }

  // Prompt order keeps the result deterministic; query.ts combines the array with
  // arrayOverlaps, so multiple genres behave as OR (match any), not AND.
  return [...indexByGenre.entries()]
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] - right[1];
      }

      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .map(([genre]) => genre);
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
  // two-digit branch. An apostrophe is accepted before or after the digits
  // ("'90s", "90's"). Two-digit decades are read as 20th century except 00s/10s.
  const pattern = /\b'?(\d{4}|\d{2})'?s\b/gi;

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

interface RuntimeRange {
  runtimeMin: number;
  runtimeMax: number;
  index: number;
}

interface TrailingRuntimeBound {
  minutes: number;
  index: number;
  max: boolean;
}

function findRuntimeRanges(prompt: string): RuntimeRange[] {
  // The same unit applies to both ends: "between 90 and 120 minutes" and
  // "90–120 minutes". A reversed range is ignored rather than silently swapped.
  const ranges: RuntimeRange[] = [];
  const patterns = [
    new RegExp(
      `\\b(?:between|from)\\s+(${NUMBER_SOURCE})\\s+(?:and|to)\\s+(${NUMBER_SOURCE})\\s+` +
        `(minutes?|mins?|hours?|hrs?|h)\\b`,
      'gi',
    ),
    new RegExp(
      `\\b(${NUMBER_SOURCE})\\s*[-–—]\\s*(${NUMBER_SOURCE})\\s+` +
        `(minutes?|mins?|hours?|hrs?|h)\\b`,
      'gi',
    ),
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const startText = match[1];
      const endText = match[2];
      const unit = match[3];

      if (startText === undefined || endText === undefined || unit === undefined) {
        continue;
      }

      const runtimeMin = runtimeMinutes(startText, unit);
      const runtimeMax = runtimeMinutes(endText, unit);

      if (runtimeMin === undefined || runtimeMax === undefined || runtimeMin > runtimeMax) {
        continue;
      }

      ranges.push({ runtimeMin, runtimeMax, index: match.index });
    }
  }

  return ranges;
}

function findTrailingRuntimeBounds(prompt: string): TrailingRuntimeBound[] {
  const pattern = new RegExp(
    `\\b(${NUMBER_SOURCE})\\s+(minutes?|mins?|hours?|hrs?|h)\\s+or\\s+(less|fewer|more)\\b`,
    'gi',
  );
  const bounds: TrailingRuntimeBound[] = [];

  for (const match of prompt.matchAll(pattern)) {
    const numberText = match[1];
    const unit = match[2];
    const direction = match[3];

    if (numberText === undefined || unit === undefined || direction === undefined) {
      continue;
    }

    const minutes = runtimeMinutes(numberText, unit);

    if (minutes === undefined) {
      continue;
    }

    bounds.push({
      minutes,
      index: match.index,
      max: direction.toLowerCase() !== 'more',
    });
  }

  return bounds;
}

function earliestBound(bounds: readonly RuntimeBound[]): RuntimeBound | undefined {
  let earliest: RuntimeBound | undefined;

  for (const bound of bounds) {
    if (earliest === undefined || bound.index < earliest.index) {
      earliest = bound;
    }
  }

  return earliest;
}

function findRuntimeBounds(prompt: string): {
  runtimeMin?: number;
  runtimeMax?: number;
} {
  const minBounds: RuntimeBound[] = [];
  const maxBounds: RuntimeBound[] = [];

  for (const range of findRuntimeRanges(prompt)) {
    minBounds.push({ minutes: range.runtimeMin, index: range.index });
    maxBounds.push({ minutes: range.runtimeMax, index: range.index });
  }

  const pattern = new RegExp(
    `\\b(no more than|no longer than|at most|less than|shorter than|under|below|up to|` +
      `maximum|max|more than|longer than|at least|above|over|minimum|min)\\s+` +
      `(${NUMBER_SOURCE})\\s+(minutes?|mins?|hours?|hrs?|h)\\b`,
    'gi',
  );

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
      maxBounds.push(bound);
    } else {
      minBounds.push(bound);
    }
  }

  for (const trailing of findTrailingRuntimeBounds(prompt)) {
    const bound = { minutes: trailing.minutes, index: trailing.index };

    if (trailing.max) {
      maxBounds.push(bound);
    } else {
      minBounds.push(bound);
    }
  }

  let min = earliestBound(minBounds);
  let max = earliestBound(maxBounds);

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
