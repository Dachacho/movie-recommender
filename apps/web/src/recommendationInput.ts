import type { RecommendationRequest, TasteRequest } from '@movie-recommender/shared';

type TasteRating = TasteRequest['ratings'][number];

/**
 * Pure assembly of the recommendation request from the guest profile and the
 * stateless taste result. A null taste vector means cold start, not an error.
 */
export function buildRecommendationInput(
  ratings: readonly TasteRating[],
  watchedIds: readonly number[],
  tasteVector: readonly number[] | null,
  prompt: string,
): RecommendationRequest {
  const trimmedPrompt = prompt.trim();
  const excludeIds = [...new Set(watchedIds)].sort((left, right) => left - right);
  const includeTasteVector = ratings.length > 0 && tasteVector !== null;

  return {
    source: 'catalog',
    limit: 4,
    ...(trimmedPrompt === '' ? {} : { prompt: trimmedPrompt }),
    ...(includeTasteVector ? { tasteVector: [...tasteVector] } : {}),
    ...(excludeIds.length === 0 ? {} : { excludeIds }),
  };
}
