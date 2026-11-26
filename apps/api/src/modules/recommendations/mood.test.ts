import { describe, expect, it } from 'vitest';
import {
  MOOD_BOOST_WEIGHT,
  moodGenreScore,
  parsePromptMood,
  type MoodGenreWeights,
} from './mood.js';

const LIGHTHEARTED: MoodGenreWeights = {
  Comedy: 0.6,
  Romance: 1,
  Family: 0.8,
  Animation: 0.4,
};

describe('parsePromptMood', () => {
  it.each([
    'lighthearted',
    'light-hearted',
    'light hearted',
    'feel-good',
    'feel good',
    'feelgood',
    'cozy',
    'cosy',
  ])('maps "%s" to the lighthearted genre affinities', (prompt) => {
    expect(parsePromptMood(prompt)).toEqual(LIGHTHEARTED);
  });

  it.each(['LIGHTHEARTED', 'Light-Hearted', 'FEEL GOOD', 'Cozy', 'COSY'])(
    'matches "%s" case-insensitively',
    (prompt) => {
      expect(parsePromptMood(prompt)).toEqual(LIGHTHEARTED);
    },
  );

  it('finds the phrase inside a longer prompt', () => {
    expect(parsePromptMood('lighthearted movie i can watch with my girlfriend')).toEqual(
      LIGHTHEARTED,
    );
  });

  it.each(['fun thriller', 'romantic drama', 'scary movie', 'a quiet drama'])(
    'returns null for "%s"',
    (prompt) => {
      expect(parsePromptMood(prompt)).toBeNull();
    },
  );

  it.each(['lightheartedness', 'uncozy', 'feelgoodness', 'cosying'])(
    'does not match the substring in "%s"',
    (prompt) => {
      expect(parsePromptMood(prompt)).toBeNull();
    },
  );
});

describe('moodGenreScore', () => {
  it('caps at the strongest matching genre instead of summing', () => {
    expect(moodGenreScore(['Romance'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT, 12);
    expect(moodGenreScore(['Comedy', 'Romance', 'Family', 'Animation'], LIGHTHEARTED)).toBeCloseTo(
      MOOD_BOOST_WEIGHT,
      12,
    );
    expect(moodGenreScore(['Comedy', 'Romance'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT, 12);
  });

  it('scales each genre weight by the boost weight', () => {
    expect(moodGenreScore(['Comedy'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT * 0.6, 12);
    expect(moodGenreScore(['Family'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT * 0.8, 12);
    expect(moodGenreScore(['Animation'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT * 0.4, 12);
  });

  it('honours an explicit evaluation override and defaults to the shipped constant', () => {
    expect(moodGenreScore(['Romance'], LIGHTHEARTED, 0.1)).toBeCloseTo(0.1, 12);
    expect(moodGenreScore(['Romance'], LIGHTHEARTED, 0)).toBe(0);
    expect(moodGenreScore(['Romance'], LIGHTHEARTED, MOOD_BOOST_WEIGHT)).toBe(
      moodGenreScore(['Romance'], LIGHTHEARTED),
    );
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid boost override %s',
    (boostWeight) => {
      expect(() => moodGenreScore(['Romance'], LIGHTHEARTED, boostWeight)).toThrow(RangeError);
    },
  );

  it('ignores unknown genre names', () => {
    expect(moodGenreScore(['Drama', 'Thriller'], LIGHTHEARTED)).toBe(0);
    expect(moodGenreScore(['Crime', 'Romance'], LIGHTHEARTED)).toBeCloseTo(MOOD_BOOST_WEIGHT, 12);
  });

  it.each([[], null, undefined])('returns 0 for empty or missing genres', (genres) => {
    expect(moodGenreScore(genres, LIGHTHEARTED)).toBe(0);
  });

  it('returns 0 when no mood weights are supplied', () => {
    expect(moodGenreScore(['Romance', 'Comedy'], null)).toBe(0);
  });
});
