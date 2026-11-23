import type { MovieCard } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_MS,
  EXPLORATION_STRENGTH,
  MAX_CANDIDATE_IDS,
  MAX_EXCLUDE_IDS,
  buildRecommendationInput,
  buildRefreshAllInput,
  buildReplacementInput,
  mergeReplacement,
  rewatchCandidateIds,
} from './recommendationInput';

const TASTE_VECTOR = Array.from({ length: 384 }, (_value, index) => (index === 0 ? 1 : 0));

const VISIBLE_IDS = [1, 2, 3, 4];

function movie(id: number): MovieCard {
  return {
    id,
    title: `Movie ${id}`,
    releaseYear: null,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
  };
}

function movies(ids: readonly number[]): MovieCard[] {
  return ids.map(movie);
}

function movieIds(movies: readonly MovieCard[]): number[] {
  return movies.map((card) => card.id);
}

const BASE = {
  ratedIds: [] as number[],
  watchedIds: [] as number[],
  tasteVector: null,
  prompt: '',
};

describe('buildRecommendationInput', () => {
  it('returns a catalog request with limit 4 and no optional fields', () => {
    const { request, droppedIds } = buildRecommendationInput({ ...BASE });

    expect(request).toEqual({ source: 'catalog', limit: 4 });
    expect(droppedIds).toEqual([]);
  });

  it('includes the taste vector when rated ids and a non-null vector exist', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [3, 7],
      tasteVector: TASTE_VECTOR,
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      tasteVector: TASTE_VECTOR,
      excludeIds: [3, 7],
    });
    expect(droppedIds).toEqual([]);
  });

  it('omits the taste vector when the taste response is null', () => {
    const { request, droppedIds } = buildRecommendationInput({ ...BASE, ratedIds: [3, 7] });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [3, 7],
    });
    expect(droppedIds).toEqual([]);
  });

  it('omits a supplied taste vector when there are no rated ids', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      tasteVector: TASTE_VECTOR,
    });

    expect(request).toEqual({ source: 'catalog', limit: 4 });
    expect(droppedIds).toEqual([]);
  });

  it('unions, sorts and deduplicates rated and watched ids into excludeIds', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [7, 3],
      watchedIds: [9, 4, 9, 2],
      tasteVector: TASTE_VECTOR,
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      tasteVector: TASTE_VECTOR,
      excludeIds: [2, 3, 4, 7, 9],
    });
    expect(droppedIds).toEqual([]);
  });

  it('excludes rated ids even when nothing has been watched', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [3, 7],
      tasteVector: TASTE_VECTOR,
    });

    expect(request).toMatchObject({ excludeIds: [3, 7] });
    expect(droppedIds).toEqual([]);
  });

  it('deduplicates ids that are both rated and watched', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [7, 3],
      watchedIds: [7, 3],
      tasteVector: TASTE_VECTOR,
    });

    expect(request).toMatchObject({ excludeIds: [3, 7] });
    expect(droppedIds).toEqual([]);
  });

  it('omits excludeIds when nothing has been rated or watched', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      tasteVector: TASTE_VECTOR,
    });

    expect(request).not.toHaveProperty('excludeIds');
    expect(droppedIds).toEqual([]);
  });

  it('trims the prompt and omits a blank prompt', () => {
    const trimmed = buildRecommendationInput({
      ...BASE,
      ratedIds: [3, 7],
      tasteVector: TASTE_VECTOR,
      prompt: '  quiet thriller  ',
    });
    const blank = buildRecommendationInput({
      ...BASE,
      ratedIds: [3, 7],
      tasteVector: TASTE_VECTOR,
      prompt: '   ',
    });

    expect(trimmed.request).toMatchObject({ prompt: 'quiet thriller' });
    expect(blank.request).not.toHaveProperty('prompt');
    expect(trimmed.droppedIds).toEqual([]);
    expect(blank.droppedIds).toEqual([]);
  });

  it('excludes active cooldowns alongside rated and watched ids', () => {
    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [3, 7],
      watchedIds: [9],
      cooldownIds: [9, 5, 1],
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [1, 3, 5, 7, 9],
    });
    expect(droppedIds).toEqual([]);
  });

  it('excludes every rated id, not just the 500-entry taste payload', () => {
    const ratedIds = Array.from({ length: 600 }, (_value, index) => index + 1);

    const { request, droppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds,
      tasteVector: TASTE_VECTOR,
    });

    const excludeIds = request.excludeIds ?? [];

    expect(excludeIds).toHaveLength(600);
    expect(excludeIds).toContain(1);
    expect(excludeIds).toContain(600);
    expect(request.tasteVector).toEqual(TASTE_VECTOR);
    expect(droppedIds).toEqual([]);
  });
});

describe('buildReplacementInput', () => {
  it('excludes every visible pick, the replaced pick and active cooldowns', () => {
    const { request, droppedIds } = buildReplacementInput({
      ratedIds: [3, 7],
      watchedIds: [9],
      tasteVector: TASTE_VECTOR,
      prompt: '  quiet thriller  ',
      visibleMovieIds: VISIBLE_IDS,
      replacedMovieId: 2,
      cooldownIds: [12, 2, 11],
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'quiet thriller',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 2, 3, 4, 7, 9, 11, 12],
    });
    expect(droppedIds).toEqual([]);
  });

  it('keeps the same request shape as a normal round when nothing else is known', () => {
    const { request, droppedIds } = buildReplacementInput({
      ...BASE,
      visibleMovieIds: [2],
      replacedMovieId: 2,
      cooldownIds: [],
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [2],
    });
    expect(droppedIds).toEqual([]);
  });

  it('keeps visible picks and cooldowns when the union reaches the id cap', () => {
    const cooldownIds = Array.from({ length: 10_005 }, (_value, index) => index + 1);

    const { request, droppedIds } = buildReplacementInput({
      ...BASE,
      visibleMovieIds: VISIBLE_IDS,
      replacedMovieId: 2,
      cooldownIds,
    });

    const excludeIds = request.excludeIds ?? [];

    expect(excludeIds).toHaveLength(MAX_EXCLUDE_IDS);
    expect(excludeIds.slice(0, 4)).toEqual(VISIBLE_IDS);
    expect(excludeIds.at(-1)).toBe(10_000);
    expect(excludeIds).not.toContain(10_001);
    expect(excludeIds).not.toContain(10_005);
    expect(droppedIds).toEqual([10_001, 10_002, 10_003, 10_004, 10_005]);
  });

  it('drops cooldown ids from the end of the sorted list, keeping them deterministic', () => {
    const cooldownIds = [5, 9_999, 7, 10_004, 10_000];

    const { request, droppedIds } = buildReplacementInput({
      ...BASE,
      visibleMovieIds: [1],
      replacedMovieId: 1,
      cooldownIds: [...Array.from({ length: 9_998 }, (_value, index) => index + 1), ...cooldownIds],
    });

    expect(request.excludeIds).toHaveLength(MAX_EXCLUDE_IDS);
    expect(request.excludeIds?.at(-1)).toBe(10_000);
    expect(droppedIds).toEqual([10_004]);
  });

  it('keeps rated, visible and replaced ids when watched ids alone exceed the cap', () => {
    const watchedIds = Array.from({ length: 10_500 }, (_value, index) => index + 100);

    const { request, droppedIds } = buildReplacementInput({
      ratedIds: [5],
      watchedIds,
      tasteVector: null,
      prompt: '',
      visibleMovieIds: VISIBLE_IDS,
      replacedMovieId: 2,
      cooldownIds: [30_000],
    });

    const excludeIds = request.excludeIds ?? [];

    expect(excludeIds).toHaveLength(MAX_EXCLUDE_IDS);
    expect(excludeIds.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(excludeIds).toContain(100);
    expect(excludeIds).toContain(10_094);
    expect(excludeIds).not.toContain(10_095);
    expect(excludeIds).not.toContain(10_599);
    expect(excludeIds).not.toContain(30_000);
    expect(new Set(excludeIds).size).toBe(excludeIds.length);
    expect(droppedIds).toEqual([
      ...Array.from({ length: 505 }, (_value, index) => 10_095 + index),
      30_000,
    ]);
  });

  it('fills the remaining room with the lowest watched ids before cooldowns', () => {
    const watchedIds = Array.from({ length: 9_996 }, (_value, index) => index + 1);

    const { request, droppedIds } = buildReplacementInput({
      ratedIds: [20_001],
      watchedIds,
      tasteVector: null,
      prompt: '',
      visibleMovieIds: [20_000],
      replacedMovieId: 20_000,
      cooldownIds: [20_003, 20_002],
    });

    const excludeIds = request.excludeIds ?? [];

    expect(excludeIds).toHaveLength(MAX_EXCLUDE_IDS);
    expect(excludeIds).toContain(20_001);
    expect(excludeIds).toContain(20_002);
    expect(excludeIds.at(-1)).toBe(20_003);
    expect(droppedIds).toEqual([]);
  });

  it('always keeps visible and replaced ids when rated ids alone exceed the cap', () => {
    const ratedIds = Array.from({ length: 10_004 }, (_value, index) => index + 1);
    const visibleMovieIds = [2, 4, 6, 10_004];
    const replacedMovieId = 10_003;

    const { request, droppedIds } = buildReplacementInput({
      ratedIds,
      watchedIds: [],
      tasteVector: TASTE_VECTOR,
      prompt: '',
      visibleMovieIds,
      replacedMovieId,
      cooldownIds: [],
    });

    const excludeIds = request.excludeIds ?? [];

    expect(excludeIds).toHaveLength(MAX_EXCLUDE_IDS);

    for (const id of [...visibleMovieIds, replacedMovieId]) {
      expect(excludeIds).toContain(id);
    }

    expect(excludeIds).toEqual([
      ...Array.from({ length: 9_998 }, (_value, index) => index + 1),
      10_003,
      10_004,
    ]);
    expect(excludeIds).toContain(9_998);
    expect(excludeIds).not.toContain(9_999);
    expect(excludeIds).not.toContain(10_002);
    expect(droppedIds).toEqual([9_999, 10_000, 10_001, 10_002]);
  });

  it('keeps every id when rated, visible and replaced ids fit under the cap', () => {
    const { request, droppedIds } = buildReplacementInput({
      ratedIds: [7, 3],
      watchedIds: [],
      tasteVector: TASTE_VECTOR,
      prompt: '',
      visibleMovieIds: VISIBLE_IDS,
      replacedMovieId: 2,
      cooldownIds: [],
    });

    expect(request.excludeIds).toEqual([1, 2, 3, 4, 7]);
    expect(droppedIds).toEqual([]);
  });
});

describe('buildRefreshAllInput', () => {
  it('excludes all visible picks and every active cooldown', () => {
    const { request, droppedIds } = buildRefreshAllInput({
      ...BASE,
      visibleMovieIds: VISIBLE_IDS,
      cooldownIds: [4, 6],
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [1, 2, 3, 4, 6],
    });
    expect(droppedIds).toEqual([]);
  });

  it('omits excludeIds when there is nothing to exclude', () => {
    const { request, droppedIds } = buildRefreshAllInput({
      ...BASE,
      visibleMovieIds: [],
      cooldownIds: [],
    });

    expect(request).toEqual({ source: 'catalog', limit: 4 });
    expect(droppedIds).toEqual([]);
  });

  it('carries the taste vector and prompt of the round being refreshed', () => {
    const { request, droppedIds } = buildRefreshAllInput({
      ratedIds: [3, 7],
      watchedIds: [],
      tasteVector: TASTE_VECTOR,
      prompt: 'funny',
      visibleMovieIds: [1],
      cooldownIds: [],
    });

    expect(request).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'funny',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 3, 7],
    });
    expect(droppedIds).toEqual([]);
  });
});

describe('rewatchCandidateIds', () => {
  it('keeps ratings at or above four stars, sorted ascending', () => {
    expect(
      rewatchCandidateIds([
        { movieId: 7, rating: 4 },
        { movieId: 2, rating: 5 },
        { movieId: 5, rating: 3.5 },
        { movieId: 3, rating: 4.5 },
        { movieId: 1, rating: 0.5 },
      ]),
    ).toEqual([2, 3, 7]);
  });

  it('includes an exact four-star rating, the half-star threshold', () => {
    expect(rewatchCandidateIds([{ movieId: 4, rating: 4 }])).toEqual([4]);
  });

  it('excludes a 3.5 rating', () => {
    expect(rewatchCandidateIds([{ movieId: 4, rating: 3.5 }])).toEqual([]);
  });

  it('returns no candidates without ratings', () => {
    expect(rewatchCandidateIds([])).toEqual([]);
  });

  it('deduplicates repeated movie ids', () => {
    expect(
      rewatchCandidateIds([
        { movieId: 3, rating: 4 },
        { movieId: 3, rating: 5 },
      ]),
    ).toEqual([3]);
  });

  it('returns every qualifying id; the request builder applies the API pool cap', () => {
    const ratings = Array.from({ length: 10_005 }, (_value, index) => ({
      movieId: index + 1,
      rating: 4,
    }));

    const ids = rewatchCandidateIds(ratings);

    expect(ids).toHaveLength(10_005);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(10_005);
  });
});

describe('source-scoped requests', () => {
  it('builds a watchlist request with candidateIds and the normal exclusions', () => {
    const { request, droppedIds, poolDroppedIds } = buildRecommendationInput({
      ...BASE,
      ratedIds: [1],
      watchedIds: [2],
      tasteVector: TASTE_VECTOR,
      prompt: '  comfort  ',
      cooldownIds: [9],
      source: { kind: 'watchlist', candidateIds: [8, 3, 8] },
    });

    expect(request).toEqual({
      source: 'watchlist',
      limit: 4,
      candidateIds: [3, 8],
      prompt: 'comfort',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 2, 9],
    });
    expect(droppedIds).toEqual([]);
    expect(poolDroppedIds).toEqual([]);
  });

  it('builds a rewatch request that excludes only visible, replaced and cooldown ids', () => {
    const { request, droppedIds, poolDroppedIds } = buildReplacementInput({
      ratedIds: [1, 6, 7],
      watchedIds: [2, 6],
      tasteVector: TASTE_VECTOR,
      prompt: 'comfort',
      visibleMovieIds: [1, 6],
      replacedMovieId: 1,
      cooldownIds: [9],
      source: { kind: 'rewatch', candidateIds: [1, 6, 7] },
    });

    expect(request).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [1, 6, 7],
      prompt: 'comfort',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 6, 9],
    });
    // Rated and watched ids must not be excluded: they are the candidate pool.
    expect(request.excludeIds).not.toContain(7);
    expect(request.excludeIds).not.toContain(2);
    expect(droppedIds).toEqual([]);
    expect(poolDroppedIds).toEqual([]);
  });

  it('keeps the round source and candidate pool in a refresh-all request', () => {
    const { request } = buildRefreshAllInput({
      ...BASE,
      visibleMovieIds: [1],
      cooldownIds: [2],
      source: { kind: 'watchlist', candidateIds: [1, 5] },
    });

    expect(request).toMatchObject({
      source: 'watchlist',
      candidateIds: [1, 5],
      excludeIds: [1, 2],
    });
  });

  it('throws for a watchlist or rewatch request without candidates', () => {
    expect(() =>
      buildRecommendationInput({ ...BASE, source: { kind: 'watchlist', candidateIds: [] } }),
    ).toThrow(/candidateIds/);
    expect(() =>
      buildRecommendationInput({ ...BASE, source: { kind: 'rewatch', candidateIds: [] } }),
    ).toThrow(/candidateIds/);
  });

  it('caps watchlist candidateIds at the endpoint limit and reports the trimmed pool', () => {
    const candidateIds = Array.from({ length: 10_005 }, (_value, index) => index + 1);

    const { request, droppedIds, poolDroppedIds } = buildRecommendationInput({
      ...BASE,
      source: { kind: 'watchlist', candidateIds: [...candidateIds, 1] },
    });

    expect(request.candidateIds).toHaveLength(MAX_CANDIDATE_IDS);
    expect(request.candidateIds?.[0]).toBe(1);
    expect(request.candidateIds?.at(-1)).toBe(10_000);
    expect(request.candidateIds).not.toContain(10_001);
    expect(droppedIds).toEqual([]);
    expect(poolDroppedIds).toEqual([10_001, 10_002, 10_003, 10_004, 10_005]);
  });

  it('caps the rewatch pool at the endpoint limit and reports the trimmed pool', () => {
    const ratings = Array.from({ length: 10_005 }, (_value, index) => ({
      movieId: index + 1,
      rating: 4,
    }));

    const { request, droppedIds, poolDroppedIds } = buildRecommendationInput({
      ...BASE,
      source: { kind: 'rewatch', candidateIds: rewatchCandidateIds(ratings) },
    });

    expect(request.source).toBe('list');
    expect(request.candidateIds).toHaveLength(MAX_CANDIDATE_IDS);
    expect(request.candidateIds?.at(-1)).toBe(10_000);
    expect(droppedIds).toEqual([]);
    expect(poolDroppedIds).toEqual([10_001, 10_002, 10_003, 10_004, 10_005]);
  });
});

describe('mergeReplacement', () => {
  it('puts the replacement movie in the rejected slot and leaves the others in place', () => {
    expect(movieIds(mergeReplacement(movies([1, 2, 3, 4]), 1, movies([9])))).toEqual([1, 9, 3, 4]);
  });

  it('removes the slot when the replacement response is empty', () => {
    expect(movieIds(mergeReplacement(movies([1, 2, 3, 4]), 1, []))).toEqual([1, 3, 4]);
  });

  it('handles a replacement of the last slot', () => {
    expect(movieIds(mergeReplacement(movies([1, 2, 3, 4]), 3, movies([9])))).toEqual([1, 2, 3, 9]);
  });

  it('uses only the first movie of a multi-movie response', () => {
    expect(movieIds(mergeReplacement(movies([1, 2, 3, 4]), 0, movies([8, 9, 10])))).toEqual([
      8, 2, 3, 4,
    ]);
  });

  it('appends when the index is out of range', () => {
    expect(movieIds(mergeReplacement(movies([1]), 4, movies([9])))).toEqual([1, 9]);
    expect(movieIds(mergeReplacement(movies([1]), -1, movies([9])))).toEqual([1, 9]);
  });

  it('does not mutate the current picks', () => {
    const current = movies([1, 2]);
    const replacement = movies([9]);

    mergeReplacement(current, 0, replacement);

    expect(movieIds(current)).toEqual([1, 2]);
    expect(movieIds(replacement)).toEqual([9]);
  });
});

describe('COOLDOWN_MS', () => {
  it('is seven days in milliseconds', () => {
    expect(COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('paste source', () => {
  it('uses the list source with the usual rated and watched exclusions', () => {
    const { request } = buildRecommendationInput({
      ...BASE,
      ratedIds: [1],
      watchedIds: [2],
      source: { kind: 'paste', candidateIds: [3, 4] },
    });

    expect(request).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [3, 4],
      excludeIds: [1, 2],
    });
  });
});

describe('exploration', () => {
  it('omits exploration when it is not supplied', () => {
    const { request } = buildRecommendationInput({ ...BASE });

    expect(request).not.toHaveProperty('exploration');
  });

  it('sends the supplied exploration value', () => {
    const { request } = buildRecommendationInput({
      ...BASE,
      exploration: EXPLORATION_STRENGTH,
    });

    expect(request).toMatchObject({ exploration: 0.5 });
  });

  it('pins the interim surprise strength at one half', () => {
    expect(EXPLORATION_STRENGTH).toBe(0.5);
  });
});
