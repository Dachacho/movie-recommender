/**
 * Size of the mood-to-genre affinity added to the ranking score. It is at most
 * a 0.18 similarity gap, so taste similarity still dominates: the term only
 * separates films the sentence embedding ranks too closely to tell apart by
 * tone (for example dark versus warm comedies). Selected on the mood tune and
 * holdout split by the pre-declared rule in
 * docs/evaluation-prompt-2026-11-26.md: 0.18 is the smallest guard-passing
 * weight within 0.01 of the guard-passing maximum holdout precision, with tune,
 * non-mood, constraint and empty-result guards held against the no-boost run.
 */
export const MOOD_BOOST_WEIGHT = 0.18;

export type MoodGenreWeights = Readonly<Record<string, number>>;

/** Phrases that trigger the additive mood term, kept for the evaluation report. */
export const MOOD_PHRASES = [
  'lighthearted',
  'light-hearted',
  'light hearted',
  'feel-good',
  'feel good',
  'feelgood',
  'cozy',
  'cosy',
] as const;

// Canonical TMDB genre names, matched only as whole words so
// "lightheartedness" and "uncozy" do not trigger the affinity.
const LIGHTHEARTED_PATTERN = /\b(?:light[\s-]?hearted|feel[\s-]?good|cozy|cosy)\b/i;

/** Max-per-genre affinity used by both the pool tilt and the diversity rerank. */
export const MOOD_GENRE_AFFINITIES: MoodGenreWeights = {
  Comedy: 0.6,
  Romance: 1,
  Family: 0.8,
  Animation: 0.4,
};

export function parsePromptMood(prompt: string): MoodGenreWeights | null {
  return LIGHTHEARTED_PATTERN.test(prompt) ? MOOD_GENRE_AFFINITIES : null;
}

/**
 * Boost for a candidate's mood affinity: the boost weight times the strongest
 * matching genre weight. Summing genres would let a broad genre tag amplify the
 * term, so the max keeps the boost capped at the boost weight. The third
 * argument is an evaluation-only override; the HTTP route never passes it.
 */
export function moodGenreScore(
  genres: readonly string[] | null | undefined,
  weights: MoodGenreWeights | null,
  boostWeight: number = MOOD_BOOST_WEIGHT,
): number {
  if (!Number.isFinite(boostWeight) || boostWeight < 0) {
    throw new RangeError(
      `boostWeight must be a finite number greater than or equal to 0, received ${boostWeight}.`,
    );
  }

  if (weights === null || genres === null || genres === undefined || genres.length === 0) {
    return 0;
  }

  let maxWeight = 0;

  for (const genre of genres) {
    const weight = weights[genre];

    if (weight !== undefined && weight > maxWeight) {
      maxWeight = weight;
    }
  }

  return boostWeight * maxWeight;
}
