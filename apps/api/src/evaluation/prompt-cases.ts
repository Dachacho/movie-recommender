import type { RecommendationFilters } from '../modules/recommendations/types.js';

/**
 * Canonical TMDB movie genre names as stored in movies.genres. The prompt set
 * labels genre relevance with these names only.
 */
export const CANONICAL_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
] as const;

export type CanonicalGenre = (typeof CANONICAL_GENRES)[number];

/** Graded relevance per genre: 0 is absent, 1 is the strongest signal. */
export type GenreWeights = Readonly<Partial<Record<CanonicalGenre, number>>>;

export type PromptCaseGroup = 'explicit' | 'soft' | 'edge' | 'control';

export interface PromptCase {
  id: string;
  prompt: string;
  group: PromptCaseGroup;
  /**
   * Filters the parser should produce exactly. Undefined means the prompt must
   * not hard-filter at all. Array order follows prompt order, with alphabetical
   * order for genres matched at the same index.
   */
  expectedFilters: RecommendationFilters | undefined;
  /** Graded genre relevance; empty for controls and for prompts with no genre signal. */
  genreWeights: GenreWeights;
}

/**
 * Labelled natural-language prompt set for the prompt parser and ranking
 * weights. Expected filters are the constraints the current filter semantics
 * can express, not a subjective judgement of result quality. Soft prompts avoid
 * every keyword the parser recognizes on purpose, so their genre labels test
 * semantic retrieval rather than keyword extraction.
 */
export const PROMPT_CASES: readonly PromptCase[] = [
  // Explicit: the prompt states a filter the parser must extract.
  {
    id: 'explicit-genre-only',
    prompt: 'a thriller',
    group: 'explicit',
    expectedFilters: { genres: ['Thriller'] },
    genreWeights: { Thriller: 1 },
  },
  {
    id: 'explicit-genre-decade-runtime',
    prompt: 'a 90s sci-fi under two hours',
    group: 'explicit',
    expectedFilters: {
      genres: ['Science Fiction'],
      yearMin: 1990,
      yearMax: 1999,
      runtimeMax: 120,
    },
    genreWeights: { 'Science Fiction': 1 },
  },
  {
    id: 'explicit-multiple-genres',
    prompt: 'a funny thriller',
    group: 'explicit',
    expectedFilters: { genres: ['Comedy', 'Thriller'] },
    genreWeights: { Comedy: 1, Thriller: 1 },
  },
  {
    id: 'explicit-runtime-range',
    prompt: 'between 2 and 3 hours',
    group: 'explicit',
    expectedFilters: { runtimeMin: 120, runtimeMax: 180 },
    genreWeights: {},
  },
  {
    id: 'explicit-four-digit-decade',
    prompt: 'a movie from the 1980s',
    group: 'explicit',
    expectedFilters: { yearMin: 1980, yearMax: 1989 },
    genreWeights: {},
  },
  {
    id: 'explicit-genre-decade',
    prompt: 'a 2000s comedy',
    group: 'explicit',
    expectedFilters: { genres: ['Comedy'], yearMin: 2000, yearMax: 2009 },
    genreWeights: { Comedy: 1 },
  },
  {
    id: 'explicit-action-adventure',
    prompt: 'an action adventure from the 1980s under 2 hours',
    group: 'explicit',
    expectedFilters: {
      genres: ['Action', 'Adventure'],
      yearMin: 1980,
      yearMax: 1989,
      runtimeMax: 120,
    },
    genreWeights: { Action: 1, Adventure: 0.8 },
  },

  // Soft: no genre keyword the parser recognizes, but a clear semantic genre.
  {
    id: 'soft-character-study',
    prompt: 'a quiet character study about loneliness',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Drama: 1 },
  },
  {
    id: 'soft-laugh-out-loud',
    prompt: 'something that will make me laugh out loud',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Comedy: 1 },
  },
  {
    id: 'soft-puzzle-in-space',
    prompt: 'a mind-bending puzzle in space',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { 'Science Fiction': 0.7, Mystery: 0.9 },
  },
  {
    id: 'soft-rainy-love-story',
    prompt: 'a slow-burning love story on a rainy night',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Romance: 1 },
  },
  {
    id: 'soft-coming-home',
    prompt: 'a heartwarming tale about coming home',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Drama: 0.7, Family: 0.6 },
  },
  {
    id: 'soft-revenge-chase',
    prompt: 'an adrenaline-fuelled tale of revenge and high-speed chases',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Action: 0.9, Thriller: 0.5 },
  },
  {
    id: 'soft-spooky-mansion',
    prompt: 'a spooky tale set in an old mansion',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Horror: 0.8, Mystery: 0.4 },
  },
  {
    id: 'soft-wartime-love',
    prompt: 'a sweeping tale of forbidden love in wartime',
    group: 'soft',
    expectedFilters: undefined,
    genreWeights: { Romance: 0.8, War: 0.7 },
  },

  // Edge: prompts the current parser handles incompletely. Every label is a
  // constraint the existing filter semantics can express.
  {
    id: 'edge-rom-com-90s',
    prompt: 'a rom-com from the 90s',
    group: 'edge',
    expectedFilters: { genres: ['Comedy', 'Romance'], yearMin: 1990, yearMax: 1999 },
    genreWeights: { Comedy: 1, Romance: 1 },
  },
  {
    id: 'edge-romantic-comedy-80s',
    prompt: "a romantic comedy from the 80's",
    group: 'edge',
    expectedFilters: { genres: ['Romance', 'Comedy'], yearMin: 1980, yearMax: 1989 },
    genreWeights: { Comedy: 1, Romance: 1 },
  },
  {
    id: 'edge-crime-70s-range',
    prompt: 'a 70s crime film between 90 and 120 minutes',
    group: 'edge',
    expectedFilters: {
      genres: ['Crime'],
      yearMin: 1970,
      yearMax: 1979,
      runtimeMin: 90,
      runtimeMax: 120,
    },
    genreWeights: { Crime: 1 },
  },
  {
    id: 'edge-comedy-or-less',
    prompt: 'a 90 minutes or less comedy',
    group: 'edge',
    expectedFilters: { genres: ['Comedy'], runtimeMax: 90 },
    genreWeights: { Comedy: 1 },
  },
  {
    id: 'edge-thriller-no-longer',
    prompt: 'a no longer than 2 hours thriller',
    group: 'edge',
    expectedFilters: { genres: ['Thriller'], runtimeMax: 120 },
    genreWeights: { Thriller: 1 },
  },
  {
    id: 'edge-scary-under-90',
    prompt: 'a scary movie under 90 minutes',
    group: 'edge',
    expectedFilters: { genres: ['Horror'], runtimeMax: 90 },
    genreWeights: { Horror: 1 },
  },
  {
    id: 'edge-negated-horror',
    prompt: 'not a horror movie',
    group: 'edge',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'edge-not-only-horror',
    prompt: 'not only horror but also romance',
    group: 'edge',
    expectedFilters: { genres: ['Horror', 'Romance'] },
    genreWeights: { Horror: 1, Romance: 1 },
  },
  {
    id: 'edge-contraction-negation',
    prompt: "I don't want horror",
    group: 'edge',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'edge-anything-but-horror',
    prompt: 'anything but horror',
    group: 'edge',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'edge-lighthearted-girlfriend',
    prompt: 'lighthearted movie i can watch with my girlfriend',
    group: 'edge',
    expectedFilters: { genres: ['Comedy'] },
    genreWeights: { Comedy: 1, Romance: 0.5 },
  },

  // Control: vague prompts with no filter and no genre signal.
  {
    id: 'control-tonight',
    prompt: 'something good to watch tonight',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'control-surprise',
    prompt: 'surprise me',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'control-quiet-evening',
    prompt: 'a movie for a quiet evening',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'control-classic',
    prompt: 'show me a classic',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'control-best-ever',
    prompt: 'the best film ever made',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
  {
    id: 'control-anything',
    prompt: 'anything at all',
    group: 'control',
    expectedFilters: undefined,
    genreWeights: {},
  },
];
