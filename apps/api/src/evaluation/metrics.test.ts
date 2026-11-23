import { describe, expect, it } from 'vitest';
import { evaluateRanking, likedIds, meanMetrics } from './metrics.js';

function relevant(...ids: number[]): ReadonlySet<number> {
  return new Set(ids);
}

describe('likedIds', () => {
  it('keeps test ratings at or above four stars', () => {
    const likes = likedIds([
      { movieId: 1, rating: 5 },
      { movieId: 2, rating: 4 },
      { movieId: 3, rating: 3.5 },
      { movieId: 4, rating: 0.5 },
    ]);

    expect([...likes]).toEqual([1, 2]);
  });

  it('returns an empty set when nothing was liked', () => {
    expect(likedIds([{ movieId: 1, rating: 3 }]).size).toBe(0);
  });
});

describe('evaluateRanking', () => {
  it('scores a perfect top four at one', () => {
    expect(evaluateRanking([1, 2, 3, 4], relevant(1, 2, 3, 4))).toEqual({
      recall: 1,
      ndcg: 1,
      mrr: 1,
    });
  });

  it('returns zeros for an empty ranked list', () => {
    expect(evaluateRanking([], relevant(1, 2))).toEqual({ recall: 0, ndcg: 0, mrr: 0 });
  });

  it('returns zeros when there are no relevant ids', () => {
    expect(evaluateRanking([1, 2, 3, 4], relevant())).toEqual({ recall: 0, ndcg: 0, mrr: 0 });
  });

  it('computes recall, discounted gain and reciprocal rank over the top four', () => {
    const metrics = evaluateRanking([9, 3, 8, 1], relevant(1, 3));

    expect(metrics.recall).toBe(1);
    // Positions 2 and 4: 1/log2(3) + 1/log2(5); ideal is 1 + 1/log2(3).
    expect(metrics.ndcg).toBeCloseTo(1.0616063 / 1.6309298, 6);
    expect(metrics.mrr).toBe(0.5);
  });

  it('only considers the first four positions for recall and NDCG', () => {
    const metrics = evaluateRanking([9, 8, 7, 6, 1], relevant(1));

    expect(metrics.recall).toBe(0);
    expect(metrics.ndcg).toBe(0);
    expect(metrics.mrr).toBe(0.2);
  });

  it('caps recall when more films were liked than positions exist', () => {
    const metrics = evaluateRanking([1, 2, 3, 4], relevant(1, 2, 3, 4, 5, 6));

    expect(metrics.recall).toBeCloseTo(4 / 6, 12);
    expect(metrics.ndcg).toBe(1);
    expect(metrics.mrr).toBe(1);
  });

  it('discounts a single relevant hit by its position', () => {
    const metrics = evaluateRanking([9, 8, 1, 7], relevant(1));

    expect(metrics.recall).toBe(1);
    expect(metrics.ndcg).toBeCloseTo(1 / Math.log2(4), 12);
    expect(metrics.mrr).toBeCloseTo(1 / 3, 12);
  });

  it('supports an explicit depth', () => {
    expect(evaluateRanking([9, 1], relevant(1), 1)).toEqual({ recall: 0, ndcg: 0, mrr: 0.5 });
  });

  it('rejects an invalid depth', () => {
    expect(() => evaluateRanking([1], relevant(1), 0)).toThrow(RangeError);
    expect(() => evaluateRanking([1], relevant(1), 1.5)).toThrow(RangeError);
  });
});

describe('meanMetrics', () => {
  it('averages each metric across users', () => {
    const mean = meanMetrics([
      { recall: 1, ndcg: 1, mrr: 1 },
      { recall: 0, ndcg: 0.5, mrr: 0.25 },
    ]);

    expect(mean.recall).toBe(0.5);
    expect(mean.ndcg).toBe(0.75);
    expect(mean.mrr).toBe(0.625);
  });

  it('returns zeros for no users', () => {
    expect(meanMetrics([])).toEqual({ recall: 0, ndcg: 0, mrr: 0 });
  });
});
