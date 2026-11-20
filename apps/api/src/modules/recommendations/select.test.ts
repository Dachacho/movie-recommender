import { describe, expect, it } from 'vitest';
import { DEFAULT_DIVERSITY_PENALTY, MAX_RECOMMENDATIONS, selectDiverse } from './select.js';
import type { ScoredCandidate } from './types.js';

function candidate(
  movieId: number,
  embedding: readonly number[],
  similarity: number,
): ScoredCandidate {
  return { movieId, embedding: [...embedding], similarity };
}

const TASTE_ALIGNED = [1, 0, 0];
const NEAR_DUPLICATE = [0.96, 0.28, 0];
const DIVERSE = [0.6, 0.8, 0];
const ORTHOGONAL = [0, 1, 0];

const highest = candidate(1, TASTE_ALIGNED, 0.9);
const nearDuplicate = candidate(2, NEAR_DUPLICATE, 0.85);
const diverse = candidate(3, DIVERSE, 0.8);

describe('selectDiverse', () => {
  describe('first pick', () => {
    it('picks the candidate with the highest similarity', () => {
      const result = selectDiverse([diverse, nearDuplicate, highest], { limit: 1 });

      expect(result.map((pick) => pick.movieId)).toEqual([1]);
      expect(result[0]?.score).toBeCloseTo(0.9, 12);
    });

    it('tie-breaks equal similarities by lower movie id', () => {
      const result = selectDiverse(
        [candidate(20, DIVERSE, 0.9), candidate(10, TASTE_ALIGNED, 0.9)],
        { limit: 1 },
      );

      expect(result.map((pick) => pick.movieId)).toEqual([10]);
    });
  });

  describe('diversity penalty', () => {
    const pool = [highest, nearDuplicate, diverse];

    it('demotes a near-duplicate below a diverse candidate when penalty > 0', () => {
      const result = selectDiverse(pool, { limit: 2, penalty: 0.3 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 3]);
      expect(result[0]?.score).toBeCloseTo(0.9, 12);
      expect(result[1]?.score).toBeCloseTo(0.62, 12);
      expect(result[1]?.similarity).toBeCloseTo(0.8, 12);
    });

    it('does not demote the near-duplicate when penalty is 0', () => {
      const result = selectDiverse(pool, { limit: 2, penalty: 0 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 2]);
      expect(result[1]?.score).toBeCloseTo(0.85, 12);
    });

    it('uses the default penalty when none is provided', () => {
      expect(DEFAULT_DIVERSITY_PENALTY).toBe(0.3);
      expect(selectDiverse(pool, { limit: 2 })).toEqual(
        selectDiverse(pool, { limit: 2, penalty: DEFAULT_DIVERSITY_PENALTY }),
      );
      expect(selectDiverse(pool, { limit: 2 }).map((pick) => pick.movieId)).toEqual([1, 3]);
    });

    it('applies the penalty against every already-selected candidate, not only the last', () => {
      const pool = [
        candidate(1, TASTE_ALIGNED, 0.9),
        candidate(2, ORTHOGONAL, 0.89),
        candidate(3, TASTE_ALIGNED, 0.84),
        candidate(4, DIVERSE, 0.8),
      ];

      const result = selectDiverse(pool, { limit: 3, penalty: 0.3 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 2, 4]);
      expect(result[2]?.score).toBeCloseTo(0.56, 12);
    });

    it('tie-breaks equal adjusted scores by lower movie id', () => {
      const pool = [
        candidate(1, TASTE_ALIGNED, 0.9),
        candidate(20, DIVERSE, 0.7),
        candidate(10, DIVERSE, 0.7),
      ];

      const result = selectDiverse(pool, { limit: 2, penalty: 0.3 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 10]);
    });

    it('treats a zero-norm similarity as 0 instead of NaN', () => {
      const pool = [candidate(1, [0, 0, 0], 0.9), candidate(2, [0, 0, 0], 0.8)];

      const result = selectDiverse(pool, { limit: 2, penalty: 0.5 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 2]);
      expect(result[1]?.score).toBeCloseTo(0.8, 12);
      expect(Number.isNaN(result[1]?.score)).toBe(false);
    });
  });

  describe('numerical stability', () => {
    function magnitudePool(magnitude: number): ScoredCandidate[] {
      return [
        candidate(1, [magnitude, 0, 0], 0.9),
        candidate(2, [magnitude, 0, 0], 0.8),
        candidate(3, [0, magnitude, 0], 0.7),
      ];
    }

    it.each([1e200, 1e-200])(
      'keeps finite scores and deterministic order at magnitude %s',
      (magnitude) => {
        const result = selectDiverse(magnitudePool(magnitude), { limit: 2, penalty: 0.3 });

        for (const pick of result) {
          expect(Number.isFinite(pick.score)).toBe(true);
          expect(Number.isFinite(pick.similarity)).toBe(true);
        }

        expect(result.map((pick) => pick.movieId)).toEqual([1, 3]);
      },
    );
  });

  describe('limit', () => {
    const pool = [
      highest,
      nearDuplicate,
      diverse,
      candidate(4, ORTHOGONAL, 0.7),
      candidate(5, [0, 0, 1], 0.6),
    ];

    it('returns exactly one pick for limit 1', () => {
      const result = selectDiverse(pool, { limit: 1 });

      expect(result).toHaveLength(1);
      expect(result[0]?.movieId).toBe(1);
    });

    it('returns up to the maximum for limit 4', () => {
      expect(MAX_RECOMMENDATIONS).toBe(4);

      const result = selectDiverse(pool, { limit: MAX_RECOMMENDATIONS });

      expect(result).toHaveLength(4);
      expect(result.map((pick) => pick.movieId)).toEqual([1, 4, 5, 2]);
    });

    it('stops when candidates run out', () => {
      const result = selectDiverse([highest, diverse], { limit: 4 });

      expect(result.map((pick) => pick.movieId)).toEqual([1, 3]);
    });
  });

  describe('candidate pools', () => {
    it('returns an empty array for empty input', () => {
      expect(selectDiverse([], { limit: 4 })).toEqual([]);
    });

    it('returns the only candidate for a single candidate', () => {
      expect(selectDiverse([diverse], { limit: 4 })).toEqual([
        { movieId: 3, similarity: 0.8, score: 0.8 },
      ]);
    });
  });

  describe('purity', () => {
    const makePool = (): ScoredCandidate[] => [
      candidate(1, TASTE_ALIGNED, 0.9),
      candidate(2, NEAR_DUPLICATE, 0.85),
      candidate(3, DIVERSE, 0.8),
    ];

    it('does not mutate the input array or its candidates', () => {
      const pool = makePool();
      const snapshot = structuredClone(pool);
      const frozen = Object.freeze(pool.map((entry) => Object.freeze(entry)));

      const result = selectDiverse(frozen, { limit: 2, penalty: 0.3 });

      expect(frozen).toEqual(snapshot);
      expect(result).toHaveLength(2);
    });

    it('returns identical output for repeated calls', () => {
      const pool = makePool();
      const first = selectDiverse(pool, { limit: 4, penalty: 0.4 });
      const second = selectDiverse(pool, { limit: 4, penalty: 0.4 });

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });
  });

  describe('validation', () => {
    const validOption = { limit: 1 };

    it.each([0, 5, 1.5])('rejects invalid limit %s', (limit) => {
      expect(() => selectDiverse([highest], { limit })).toThrow(RangeError);
      expect(() => selectDiverse([highest], { limit })).toThrow(/limit/);
    });

    it.each([-0.1, 1.1, Number.NaN])('rejects invalid penalty %s', (penalty) => {
      expect(() => selectDiverse([highest], { limit: 1, penalty })).toThrow(RangeError);
      expect(() => selectDiverse([highest], { limit: 1, penalty })).toThrow(/penalty/);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects invalid movieId %s', (movieId) => {
      const pool = [candidate(movieId, TASTE_ALIGNED, 0.9)];

      expect(() => selectDiverse(pool, validOption)).toThrow(RangeError);
      expect(() => selectDiverse(pool, validOption)).toThrow(/movieId/);
      expect(() => selectDiverse(pool, validOption)).toThrow(`received ${String(movieId)}.`);
    });

    it('rejects duplicate movie ids', () => {
      const pool = [candidate(7, TASTE_ALIGNED, 0.9), candidate(7, DIVERSE, 0.8)];

      expect(() => selectDiverse(pool, validOption)).toThrow(RangeError);
      expect(() => selectDiverse(pool, validOption)).toThrow(/duplicate/i);
    });

    it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
      'rejects non-finite similarity %s',
      (similarity) => {
        expect(() => selectDiverse([candidate(1, TASTE_ALIGNED, similarity)], validOption)).toThrow(
          RangeError,
        );
        expect(() => selectDiverse([candidate(1, TASTE_ALIGNED, similarity)], validOption)).toThrow(
          /similarity/,
        );
      },
    );

    it('rejects an empty embedding', () => {
      const pool = [candidate(1, [], 0.9)];

      expect(() => selectDiverse(pool, validOption)).toThrow(RangeError);
      expect(() => selectDiverse(pool, validOption)).toThrow(/embedding/);
    });

    it('rejects non-finite embedding values', () => {
      const pool = [candidate(1, [1, Number.NaN, 0], 0.9)];

      expect(() => selectDiverse(pool, validOption)).toThrow(RangeError);
      expect(() => selectDiverse(pool, validOption)).toThrow(/embedding/);
    });

    it('rejects mismatched embedding lengths', () => {
      const pool = [candidate(1, TASTE_ALIGNED, 0.9), candidate(2, [0.6, 0.8], 0.8)];

      expect(() => selectDiverse(pool, validOption)).toThrow(RangeError);
      expect(() => selectDiverse(pool, validOption)).toThrow(/embedding/);
    });
  });
});
