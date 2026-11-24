import type { MovieCard } from '@movie-recommender/shared';
import { describe, expect, it, vi } from 'vitest';
import { createMovieLookup } from './movieLookup';

function movieCard(id: number): MovieCard {
  return {
    id,
    title: `Movie ${id}`,
    releaseYear: 2000,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createMovieLookup', () => {
  it('dedupes ids and returns every unique id', async () => {
    const fetcher = vi.fn(async (movieId: number) => movieCard(movieId));
    const lookup = createMovieLookup(fetcher);

    const result = await lookup.resolveMany([2, 1, 2, 3, 1]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect([...result.keys()]).toEqual([2, 1, 3]);
    expect(result.get(1)).toEqual(movieCard(1));
    expect(result.get(2)).toEqual(movieCard(2));
    expect(result.get(3)).toEqual(movieCard(3));
  });

  it('serves a resolved movie from cache on a later call', async () => {
    const fetcher = vi.fn(async (movieId: number) => movieCard(movieId));
    const lookup = createMovieLookup(fetcher);

    await lookup.resolveMany([5]);
    const second = await lookup.resolveMany([5, 5]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.get(5)).toEqual(movieCard(5));
  });

  it('serves a cached missing movie as null without refetching', async () => {
    const fetcher = vi.fn(async (_movieId: number) => null);
    const lookup = createMovieLookup(fetcher);

    const first = await lookup.resolveMany([9]);
    const second = await lookup.resolveMany([9]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.get(9)).toBeNull();
    expect(second.get(9)).toBeNull();
  });

  it('shares an in-flight request between overlapping calls', async () => {
    const gate = deferred<MovieCard | null>();
    const fetcher = vi.fn(() => gate.promise);
    const lookup = createMovieLookup(fetcher);

    const first = lookup.resolveMany([4]);
    const second = lookup.resolveMany([4]);
    gate.resolve(movieCard(4));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstResult.get(4)).toEqual(movieCard(4));
    expect(secondResult.get(4)).toEqual(movieCard(4));
  });

  it('never exceeds the concurrency cap', async () => {
    const pending = new Map<number, Deferred<MovieCard | null>>();
    let active = 0;
    let maxActive = 0;

    const lookup = createMovieLookup((movieId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<MovieCard | null>();
      pending.set(movieId, gate);

      return gate.promise.finally(() => {
        active -= 1;
      });
    }, 2);

    const batch = lookup.resolveMany([1, 2, 3, 4, 5]);
    await tick();

    expect([...pending.keys()]).toEqual([1, 2]);

    pending.get(1)?.resolve(movieCard(1));
    await tick();
    expect([...pending.keys()]).toEqual([1, 2, 3]);

    pending.get(2)?.resolve(null);
    await tick();
    expect([...pending.keys()]).toEqual([1, 2, 3, 4]);

    pending.get(3)?.resolve(movieCard(3));
    await tick();
    expect([...pending.keys()]).toEqual([1, 2, 3, 4, 5]);

    pending.get(4)?.resolve(null);
    pending.get(5)?.resolve(movieCard(5));

    const result = await batch;

    expect(result.size).toBe(5);
    expect(result.get(1)).toEqual(movieCard(1));
    expect(result.get(2)).toBeNull();
    expect(result.get(3)).toEqual(movieCard(3));
    expect(result.get(4)).toBeNull();
    expect(result.get(5)).toEqual(movieCard(5));
    expect(maxActive).toBe(2);
  });

  it('resolves a rejected fetch to null without failing the batch', async () => {
    const fetcher = vi.fn(async (movieId: number) => {
      if (movieId === 2) {
        throw new Error('catalog unavailable');
      }

      return movieCard(movieId);
    });
    const lookup = createMovieLookup(fetcher);

    const result = await lookup.resolveMany([1, 2, 3]);
    const repeated = await lookup.resolveMany([2]);

    expect(result.get(1)).toEqual(movieCard(1));
    expect(result.get(2)).toBeNull();
    expect(result.get(3)).toEqual(movieCard(3));
    expect(repeated.get(2)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('returns an empty map and does not call the fetcher for no ids', async () => {
    const fetcher = vi.fn<(movieId: number) => Promise<MovieCard | null>>();
    const lookup = createMovieLookup(fetcher);

    await expect(lookup.resolveMany([])).resolves.toEqual(new Map());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps results associated by id regardless of completion order', async () => {
    const pending = new Map<number, Deferred<MovieCard | null>>();
    const lookup = createMovieLookup((movieId) => {
      const gate = deferred<MovieCard | null>();
      pending.set(movieId, gate);

      return gate.promise;
    });

    const batch = lookup.resolveMany([3, 2, 1]);
    await tick();

    pending.get(1)?.resolve(movieCard(1));
    pending.get(3)?.resolve(movieCard(3));
    pending.get(2)?.resolve(null);

    const result = await batch;

    expect([...result.entries()]).toEqual([
      [3, movieCard(3)],
      [2, null],
      [1, movieCard(1)],
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default concurrency cap when given %s',
    async (concurrency) => {
      const pending = new Map<number, Deferred<MovieCard | null>>();
      let active = 0;
      let maxActive = 0;

      const lookup = createMovieLookup((movieId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred<MovieCard | null>();
        pending.set(movieId, gate);

        return gate.promise.finally(() => {
          active -= 1;
        });
      }, concurrency);

      const batch = lookup.resolveMany([1, 2, 3, 4, 5, 6]);
      await tick();

      expect([...pending.keys()]).toEqual([1, 2, 3, 4]);
      expect(maxActive).toBe(4);

      for (const gate of pending.values()) {
        gate.resolve(null);
      }

      await tick();

      for (const gate of pending.values()) {
        gate.resolve(null);
      }

      const result = await batch;

      expect([...result.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
      expect([...result.values()]).toEqual([null, null, null, null, null, null]);
      expect(maxActive).toBe(4);
    },
  );
});
