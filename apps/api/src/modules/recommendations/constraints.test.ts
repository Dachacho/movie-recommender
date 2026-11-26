import { describe, expect, it } from 'vitest';
import { parsePromptConstraints } from './constraints.js';
import type { RecommendationFilters } from './types.js';

const MIN_YEAR = 1870;
const MAX_YEAR = 2100;

function expectFilters(prompt: string): RecommendationFilters {
  const filters = parsePromptConstraints(prompt);

  if (filters === undefined) {
    throw new Error(`Expected constraints for prompt: ${prompt}`);
  }

  return filters;
}

function expectValidFilters(filters: RecommendationFilters | undefined): void {
  if (filters === undefined) {
    return;
  }

  if (filters.yearMin !== undefined) {
    expect(filters.yearMin).toBeGreaterThanOrEqual(MIN_YEAR);
    expect(Number.isInteger(filters.yearMin)).toBe(true);
  }

  if (filters.yearMax !== undefined) {
    expect(filters.yearMax).toBeLessThanOrEqual(MAX_YEAR);
    expect(Number.isInteger(filters.yearMax)).toBe(true);
  }

  for (const runtime of [filters.runtimeMin, filters.runtimeMax]) {
    if (runtime !== undefined) {
      expect(runtime).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(runtime)).toBe(true);
    }
  }

  if (filters.runtimeMin !== undefined && filters.runtimeMax !== undefined) {
    expect(filters.runtimeMin).toBeLessThanOrEqual(filters.runtimeMax);
  }

  if (filters.yearMin !== undefined && filters.yearMax !== undefined) {
    expect(filters.yearMin).toBeLessThanOrEqual(filters.yearMax);
  }
}

describe('parsePromptConstraints', () => {
  it('maps a mood prompt to the canonical thriller genre', () => {
    expect(parsePromptConstraints('sweaty thriller')).toEqual({ genres: ['Thriller'] });
  });

  it('parses genre, decade and runtime from one prompt', () => {
    expect(parsePromptConstraints('a 90s sci-fi under two hours')).toEqual({
      genres: ['Science Fiction'],
      yearMin: 1990,
      yearMax: 1999,
      runtimeMax: 120,
    });
  });

  it('returns undefined when nothing is recognized', () => {
    expect(parsePromptConstraints('a quiet film about loneliness')).toBeUndefined();
    expect(parsePromptConstraints('')).toBeUndefined();
    expect(parsePromptConstraints('   ')).toBeUndefined();
  });

  it.each(['thrillingly paced', 'a dramatically lit room', 'an actionable plan'])(
    'does not match a genre inside another word: %s',
    (prompt) => {
      expect(parsePromptConstraints(prompt)).toBeUndefined();
    },
  );

  it('does not treat a title reference as a War constraint', () => {
    expect(parsePromptConstraints('something like star wars')).toBeUndefined();
  });

  it.each([
    ['sci-fi', 'Science Fiction'],
    ['sci fi', 'Science Fiction'],
    ['science fiction', 'Science Fiction'],
    ['scifi', 'Science Fiction'],
    ['horror', 'Horror'],
    ['documentaries', 'Documentary'],
    ['romance', 'Romance'],
    ['animation', 'Animation'],
    ['family', 'Family'],
    ['fantasy', 'Fantasy'],
    ['mystery', 'Mystery'],
    ['crime', 'Crime'],
    ['action', 'Action'],
    ['adventure', 'Adventure'],
    ['drama', 'Drama'],
    ['war', 'War'],
    ['westerns', 'Western'],
    ['musical', 'Music'],
  ])('maps the genre keyword %s to %s', (prompt, genre) => {
    expect(expectFilters(prompt).genres).toContain(genre);
  });

  it('maps historical to the canonical history genre', () => {
    expect(expectFilters('a historical epic').genres).toContain('History');
  });

  it('collects multiple genres in prompt order', () => {
    // Multiple genres share one array, and the query applies arrayOverlaps (OR).
    expect(expectFilters('a funny thriller').genres).toEqual(['Comedy', 'Thriller']);
  });

  it.each([
    ['from the 90s', 1990],
    ['the 1990s', 1990],
    ['the 1980s', 1980],
    ['the 2000s', 2000],
    ['the 70s', 1970],
  ])('maps the decade in %s to %i', (prompt, start) => {
    expect(expectFilters(prompt)).toEqual({ yearMin: start, yearMax: start + 9 });
  });

  it('uses the first mentioned decade when two conflict', () => {
    expect(expectFilters('a 90s movie or an 80s movie')).toEqual({ yearMin: 1990, yearMax: 1999 });
    expect(expectFilters('from the 1990s, not the 80s')).toEqual({
      yearMin: 1990,
      yearMax: 1999,
    });
  });

  it('ignores decades outside the catalog range', () => {
    expect(parsePromptConstraints('the 1800s')).toBeUndefined();
  });

  it.each([
    ['under 90 minutes', { runtimeMax: 90 }],
    ['less than 1.5 hours', { runtimeMax: 90 }],
    ['shorter than 100 min', { runtimeMax: 100 }],
    ['shorter than three hours', { runtimeMax: 180 }],
    ['over 2 hours', { runtimeMin: 120 }],
    ['longer than 150 minutes', { runtimeMin: 150 }],
    ['at least 90 minutes', { runtimeMin: 90 }],
    ['at least two hours', { runtimeMin: 120 }],
    ['less than one hour', { runtimeMax: 60 }],
  ])('parses runtime constraint %s', (prompt, expected) => {
    expect(parsePromptConstraints(prompt)).toEqual(expected);
  });

  it('requires a time unit before treating a number as runtime', () => {
    expect(parsePromptConstraints('under 90')).toBeUndefined();
  });

  it('keeps the first bound when runtime bounds conflict', () => {
    expect(parsePromptConstraints('under 90 minutes but over 2 hours')).toEqual({
      runtimeMax: 90,
    });
    expect(parsePromptConstraints('over 2 hours but under 90 minutes')).toEqual({
      runtimeMin: 120,
    });
  });

  it('is case-insensitive', () => {
    expect(parsePromptConstraints('A SWEATY THRILLER')).toEqual({ genres: ['Thriller'] });
    expect(parsePromptConstraints('FROM THE 1990S, UNDER TWO HOURS')).toEqual({
      yearMin: 1990,
      yearMax: 1999,
      runtimeMax: 120,
    });
  });

  it('returns values the filter validation accepts', () => {
    for (const prompt of [
      'a 90s sci-fi under two hours',
      'from the 70s over 2 hours',
      'a 2000s comedy shorter than three hours',
      'a 1990s drama under 90 minutes',
    ]) {
      expectValidFilters(parsePromptConstraints(prompt));
    }
  });

  it.each([
    ['a rom-com', { genres: ['Comedy', 'Romance'] }],
    ['a romcom', { genres: ['Comedy', 'Romance'] }],
    ['a rom-com from the 90s', { genres: ['Comedy', 'Romance'], yearMin: 1990, yearMax: 1999 }],
  ])('maps the rom-com in %s to Romance and Comedy', (prompt, expected) => {
    expect(parsePromptConstraints(prompt)).toEqual(expected);
  });

  it.each([
    ["the 80's", 1980],
    ["the 90's", 1990],
    ["the 1990's", 1990],
    ["the '90s", 1990],
  ])('parses the apostrophe decade in %s', (prompt, start) => {
    expect(expectFilters(prompt)).toEqual({ yearMin: start, yearMax: start + 9 });
  });

  it.each([
    ['between 90 and 120 minutes', { runtimeMin: 90, runtimeMax: 120 }],
    ['between two and three hours', { runtimeMin: 120, runtimeMax: 180 }],
    ['from 90 to 120 minutes', { runtimeMin: 90, runtimeMax: 120 }],
    ['from 1 to 2 hours', { runtimeMin: 60, runtimeMax: 120 }],
    ['90–120 minutes', { runtimeMin: 90, runtimeMax: 120 }],
    ['90 - 120 min', { runtimeMin: 90, runtimeMax: 120 }],
  ])('parses the runtime range %s', (prompt, expected) => {
    expect(parsePromptConstraints(prompt)).toEqual(expected);
  });

  it.each([
    ['90 minutes or less', { runtimeMax: 90 }],
    ['90 mins or fewer', { runtimeMax: 90 }],
    ['2 hours or less', { runtimeMax: 120 }],
    ['90 minutes or more', { runtimeMin: 90 }],
    ['2 hours or more', { runtimeMin: 120 }],
  ])('parses the trailing runtime bound %s', (prompt, expected) => {
    expect(parsePromptConstraints(prompt)).toEqual(expected);
  });

  it('parses no longer than as an upper runtime bound', () => {
    expect(parsePromptConstraints('no longer than 2 hours')).toEqual({ runtimeMax: 120 });
    expect(parsePromptConstraints('a no longer than 2 hours thriller')).toEqual({
      genres: ['Thriller'],
      runtimeMax: 120,
    });
  });

  it.each([
    [
      'under 90 minutes, but between 100 and 120 minutes keeps the first max 90 and drops the later conflicting min',
      'under 90 minutes, but between 100 and 120 minutes',
      { runtimeMax: 90 },
    ],
    [
      'between 100 and 120 minutes, but under 90 minutes keeps the earlier range (min 100, max 120)',
      'between 100 and 120 minutes, but under 90 minutes',
      { runtimeMin: 100, runtimeMax: 120 },
    ],
    [
      'under 3 hours, but between 100 and 120 minutes keeps the first max 180 and first min 100',
      'under 3 hours, but between 100 and 120 minutes',
      { runtimeMin: 100, runtimeMax: 180 },
    ],
    [
      '90 minutes or less, but over 2 hours keeps the first max 90 and drops the later conflicting min',
      '90 minutes or less, but over 2 hours',
      { runtimeMax: 90 },
    ],
  ])('%s', (_name, prompt, expected) => {
    expect(parsePromptConstraints(prompt)).toEqual(expected);
  });

  it.each(['a scary movie', 'a frightening film'])('maps %s to Horror', (prompt) => {
    expect(expectFilters(prompt).genres).toContain('Horror');
  });

  it.each(['not a horror movie', 'no horror', 'a movie without horror'])(
    'does not turn the negated genre in %s into a positive filter',
    (prompt) => {
      expect(parsePromptConstraints(prompt)).toBeUndefined();
    },
  );

  it('suppresses both genres in a negated compound genre', () => {
    expect(parsePromptConstraints('not a romantic comedy')).toBeUndefined();
  });

  it('keeps a genre mentioned after the negated clause', () => {
    expect(parsePromptConstraints('not a horror movie, but a thriller')).toEqual({
      genres: ['Thriller'],
    });
    expect(parsePromptConstraints('not horror but comedy')).toEqual({ genres: ['Comedy'] });
  });

  it('treats not only as inclusion, not negation', () => {
    expect(parsePromptConstraints('not only horror but also romance')).toEqual({
      genres: ['Horror', 'Romance'],
    });
    expect(parsePromptConstraints('not only a horror movie')).toEqual({ genres: ['Horror'] });
  });

  it.each([
    ["I don't want horror"],
    ['I dont want horror'],
    ['I don\u2019t want horror'],
    ["I didn't like horror"],
    ["it doesn't need horror"],
    ["I wouldn't watch horror"],
    ["I won't watch horror"],
  ])('treats the contraction in %s as negation', (prompt) => {
    expect(parsePromptConstraints(prompt)).toBeUndefined();
  });

  it.each([
    ['anything but horror'],
    ['all but horror'],
    ['anything but a horror movie'],
    ['all but the horror'],
  ])('treats the idiom in %s as negation', (prompt) => {
    expect(parsePromptConstraints(prompt)).toBeUndefined();
  });
});
