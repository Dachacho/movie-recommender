/** Number of recommendations the product delivers, used as the metric cutoff. */
export const METRICS_DEPTH = 4;

/** Test ratings at or above this value count as held-out likes. */
export const LIKE_THRESHOLD = 4;

export interface RankingMetrics {
  recall: number;
  ndcg: number;
  mrr: number;
}

export interface RatedMovie {
  movieId: number;
  rating: number;
}

export function likedIds(ratings: readonly RatedMovie[]): Set<number> {
  const ids = new Set<number>();

  for (const rating of ratings) {
    if (rating.rating >= LIKE_THRESHOLD) {
      ids.add(rating.movieId);
    }
  }

  return ids;
}

function validateDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 1) {
    throw new RangeError(`depth must be a positive integer, received ${depth}.`);
  }
}

/**
 * Binary-relevance metrics over the head of a ranked list: Recall@k, NDCG@k
 * and MRR. A held-out like is equally relevant to every other like, so the
 * ideal DCG is the sum of the first min(likes, k) position discounts. An empty
 * list or an empty relevant set scores zero on every metric.
 */
export function evaluateRanking(
  ranked: readonly number[],
  relevant: ReadonlySet<number>,
  depth: number = METRICS_DEPTH,
): RankingMetrics {
  validateDepth(depth);

  let hits = 0;
  let dcg = 0;

  for (let index = 0; index < Math.min(ranked.length, depth); index += 1) {
    const movieId = ranked[index];

    if (movieId !== undefined && relevant.has(movieId)) {
      hits += 1;
      dcg += 1 / Math.log2(index + 2);
    }
  }

  const recall = relevant.size === 0 ? 0 : hits / relevant.size;

  let idcg = 0;

  for (let index = 0; index < Math.min(relevant.size, depth); index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }

  const ndcg = idcg === 0 ? 0 : dcg / idcg;

  let mrr = 0;

  for (let index = 0; index < ranked.length; index += 1) {
    const movieId = ranked[index];

    if (movieId !== undefined && relevant.has(movieId)) {
      mrr = 1 / (index + 1);
      break;
    }
  }

  return { recall, ndcg, mrr };
}

export function meanMetrics(results: readonly RankingMetrics[]): RankingMetrics {
  if (results.length === 0) {
    return { recall: 0, ndcg: 0, mrr: 0 };
  }

  let recall = 0;
  let ndcg = 0;
  let mrr = 0;

  for (const result of results) {
    recall += result.recall;
    ndcg += result.ndcg;
    mrr += result.mrr;
  }

  return {
    recall: recall / results.length,
    ndcg: ndcg / results.length,
    mrr: mrr / results.length,
  };
}
