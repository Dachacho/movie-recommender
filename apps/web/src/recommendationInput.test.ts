import type { TasteRequest } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import { buildRecommendationInput } from './recommendationInput';

type TasteRating = TasteRequest['ratings'][number];

const TASTE_VECTOR = Array.from({ length: 384 }, (_value, index) => (index === 0 ? 1 : 0));

const RATINGS: TasteRating[] = [
  { movieId: 7, rating: 4.5 },
  { movieId: 3, rating: 2 },
];

describe('buildRecommendationInput', () => {
  it('returns a catalog request with limit 4 and no optional fields', () => {
    expect(buildRecommendationInput([], [], null, '')).toEqual({
      source: 'catalog',
      limit: 4,
    });
  });

  it('includes the taste vector when ratings and a non-null vector exist', () => {
    expect(buildRecommendationInput(RATINGS, [], TASTE_VECTOR, '')).toEqual({
      source: 'catalog',
      limit: 4,
      tasteVector: TASTE_VECTOR,
    });
  });

  it('omits the taste vector when the taste response is null', () => {
    expect(buildRecommendationInput(RATINGS, [], null, '')).toEqual({
      source: 'catalog',
      limit: 4,
    });
  });

  it('omits a supplied taste vector when there are no ratings', () => {
    expect(buildRecommendationInput([], [], TASTE_VECTOR, '')).toEqual({
      source: 'catalog',
      limit: 4,
    });
  });

  it('sorts and deduplicates watched ids into excludeIds', () => {
    expect(buildRecommendationInput(RATINGS, [9, 4, 9, 2], TASTE_VECTOR, '')).toEqual({
      source: 'catalog',
      limit: 4,
      tasteVector: TASTE_VECTOR,
      excludeIds: [2, 4, 9],
    });
  });

  it('omits excludeIds when no movies have been watched', () => {
    expect(buildRecommendationInput(RATINGS, [], TASTE_VECTOR, '')).not.toHaveProperty(
      'excludeIds',
    );
  });

  it('trims the prompt and omits a blank prompt', () => {
    expect(buildRecommendationInput(RATINGS, [], TASTE_VECTOR, '  quiet thriller  ')).toMatchObject(
      {
        prompt: 'quiet thriller',
      },
    );
    expect(buildRecommendationInput(RATINGS, [], TASTE_VECTOR, '   ')).not.toHaveProperty('prompt');
  });
});
