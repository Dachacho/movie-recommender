import { computeTasteVector, type RatedEmbedding } from '../modules/taste/vector.js';
import type { MappedRating } from './load.js';

export interface TasteVectorResult {
  vector: number[] | null;
  usedRatings: number;
  missingEmbeddings: number;
}

/**
 * Reuses the production taste-vector calculation for a user's train ratings.
 * Films without a stored embedding are skipped; if none remain, the user is a
 * cold start and the vector is null.
 */
export function buildTasteVector(
  train: readonly MappedRating[],
  embeddings: ReadonlyMap<number, readonly number[]>,
): TasteVectorResult {
  const rated: RatedEmbedding[] = [];
  let missingEmbeddings = 0;

  for (const rating of train) {
    const embedding = embeddings.get(rating.movieId);

    if (embedding === undefined) {
      missingEmbeddings += 1;
      continue;
    }

    rated.push({ movieId: rating.movieId, rating: rating.rating, embedding });
  }

  return {
    vector: computeTasteVector(rated),
    usedRatings: rated.length,
    missingEmbeddings,
  };
}
