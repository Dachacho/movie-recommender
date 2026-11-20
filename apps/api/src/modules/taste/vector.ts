export const TASTE_BASELINE = 2.5;
export const MIN_TASTE_NORM = 1e-9;

export interface RatedEmbedding {
  movieId: number;
  rating: number;
  embedding: readonly number[];
}

function validateEntry(movieId: number, rating: number, embedding: readonly number[]): void {
  if (!Number.isInteger(movieId) || movieId <= 0) {
    throw new RangeError(`movieId must be a positive integer, received ${movieId}.`);
  }

  if (!Number.isFinite(rating) || rating < 0.5 || rating > 5 || !Number.isInteger(rating * 2)) {
    throw new RangeError(
      `Rating for movieId ${movieId} must be a half-star value between 0.5 and 5, received ${rating}.`,
    );
  }

  if (embedding.length === 0) {
    throw new Error(`Embedding for movieId ${movieId} must not be empty.`);
  }

  for (let index = 0; index < embedding.length; index += 1) {
    if (!Number.isFinite(embedding[index])) {
      throw new RangeError(`Embedding for movieId ${movieId} must contain only finite numbers.`);
    }
  }
}

export function computeTasteVector(rated: readonly RatedEmbedding[]): number[] | null {
  if (rated.length === 0) {
    return null;
  }

  const seenMovieIds = new Set<number>();
  let weightedSum: number[] = [];
  let dimension: number | null = null;

  for (const { movieId, rating, embedding } of rated) {
    validateEntry(movieId, rating, embedding);

    if (seenMovieIds.has(movieId)) {
      throw new Error(`Duplicate rating for movieId ${movieId}.`);
    }
    seenMovieIds.add(movieId);

    if (dimension === null) {
      dimension = embedding.length;
      weightedSum = new Array<number>(dimension).fill(0);
    } else if (embedding.length !== dimension) {
      throw new Error(
        `Embedding for movieId ${movieId} has ${embedding.length} dimensions, expected ${dimension}.`,
      );
    }

    const weight = rating - TASTE_BASELINE;
    for (let index = 0; index < embedding.length; index += 1) {
      weightedSum[index] = (weightedSum[index] ?? 0) + (embedding[index] ?? 0) * weight;
    }
  }

  let norm = 0;
  for (const value of weightedSum) {
    norm = Math.hypot(norm, value);
  }

  if (!Number.isFinite(norm) || norm <= MIN_TASTE_NORM) {
    return null;
  }

  return weightedSum.map((value) => value / norm);
}
