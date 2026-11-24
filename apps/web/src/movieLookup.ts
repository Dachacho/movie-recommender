import type { MovieCard } from '@movie-recommender/shared';

export interface MovieLookup {
  /** Resolves each id at most once; failures resolve to null. */
  resolveMany(ids: readonly number[]): Promise<Map<number, MovieCard | null>>;
}

const DEFAULT_CONCURRENCY = 4;

export function createMovieLookup(
  fetcher: (movieId: number) => Promise<MovieCard | null>,
  concurrency = DEFAULT_CONCURRENCY,
): MovieLookup {
  const limit = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : DEFAULT_CONCURRENCY;
  const cache = new Map<number, MovieCard | null>();
  const inFlight = new Map<number, Promise<MovieCard | null>>();
  const queue: (() => void)[] = [];
  let active = 0;

  function runLimited(task: () => Promise<MovieCard | null>): Promise<MovieCard | null> {
    return new Promise((resolve) => {
      const start = (): void => {
        active += 1;

        void Promise.resolve()
          .then(task)
          .then(
            (movie) => resolve(movie),
            () => resolve(null),
          )
          .finally(() => {
            active -= 1;

            const next = queue.shift();

            if (next !== undefined) {
              next();
            }
          });
      };

      if (active < limit) {
        start();
      } else {
        queue.push(start);
      }
    });
  }

  function load(movieId: number): Promise<MovieCard | null> {
    const cached = cache.get(movieId);

    if (cached !== undefined || cache.has(movieId)) {
      return Promise.resolve(cached ?? null);
    }

    const existing = inFlight.get(movieId);

    if (existing !== undefined) {
      return existing;
    }

    const pending = runLimited(() => fetcher(movieId)).then((movie) => {
      cache.set(movieId, movie);
      inFlight.delete(movieId);

      return movie;
    });

    inFlight.set(movieId, pending);

    return pending;
  }

  async function resolveMany(ids: readonly number[]): Promise<Map<number, MovieCard | null>> {
    const uniqueIds = [...new Set(ids)];
    const results = new Map<number, MovieCard | null>();

    for (const movieId of uniqueIds) {
      results.set(movieId, null);
    }

    await Promise.all(
      uniqueIds.map(async (movieId) => {
        results.set(movieId, await load(movieId));
      }),
    );

    return results;
  }

  return { resolveMany };
}
