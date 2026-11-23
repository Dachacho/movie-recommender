import type { Database } from '../db/client.js';
import { findNearestMovies } from '../modules/recommendations/query.js';
import {
  MAX_RECOMMENDATIONS,
  applyExploration,
  selectDiverse,
} from '../modules/recommendations/select.js';
import type { CatalogEntry } from './load.js';

/** Retrieval depth for the taste ranking and both baselines. */
export const EVALUATION_CANDIDATES = 100;

/** Genres taken from a user's train likes to build the genre baseline profile. */
export const GENRE_PROFILE_SIZE = 3;

export interface UserRanking {
  showcase: number[];
  popularity: number[];
  genre: number[];
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, received ${limit}.`);
  }
}

/**
 * The user's strongest genres from train likes: count each genre across the
 * liked films, then rank by count and break ties alphabetically. An empty
 * profile means no genre signal, which leaves the genre baseline at id order.
 */
export function topLikedGenres(
  liked: readonly CatalogEntry[],
  limit: number = GENRE_PROFILE_SIZE,
): string[] {
  validateLimit(limit);

  const counts = new Map<string, number>();

  for (const movie of liked) {
    for (const genre of movie.genres) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(([leftGenre, leftCount], [rightGenre, rightCount]) => {
      if (leftCount !== rightCount) {
        return rightCount - leftCount;
      }

      return leftGenre < rightGenre ? -1 : leftGenre > rightGenre ? 1 : 0;
    })
    .slice(0, limit)
    .map(([genre]) => genre);
}

/** Popularity baseline: vote count descending, films without votes last, id ascending. */
export function rankByPopularity(universe: readonly CatalogEntry[], limit: number): number[] {
  validateLimit(limit);

  return [...universe]
    .sort((left, right) => {
      if (left.voteCount === null && right.voteCount === null) {
        return left.movieId - right.movieId;
      }

      if (left.voteCount === null) {
        return 1;
      }

      if (right.voteCount === null) {
        return -1;
      }

      if (left.voteCount !== right.voteCount) {
        return right.voteCount - left.voteCount;
      }

      return left.movieId - right.movieId;
    })
    .slice(0, limit)
    .map((entry) => entry.movieId);
}

/** Genre baseline: most shared genres with the profile, then id ascending. */
export function rankByGenre(
  universe: readonly CatalogEntry[],
  genres: readonly string[],
  limit: number,
): number[] {
  validateLimit(limit);

  const wanted = new Set(genres);

  return universe
    .map((entry) => {
      let shared = 0;

      for (const genre of entry.genres) {
        if (wanted.has(genre)) {
          shared += 1;
        }
      }

      return { movieId: entry.movieId, shared };
    })
    .sort((left, right) =>
      left.shared !== right.shared ? right.shared - left.shared : left.movieId - right.movieId,
    )
    .slice(0, limit)
    .map((entry) => entry.movieId);
}

/**
 * Ranks one user against the catalog. The showcase path mirrors production:
 * findNearestMovies supplies the taste pool, exploration stays at 0, and
 * selectDiverse applies the same quality tilt, diversity penalty and limit the
 * API serves. Both baselines rank the same eligible universe minus every film
 * the user rated in train; held-out test films stay eligible, otherwise no
 * relevant item could ever be retrieved.
 */
export async function rankUser(
  db: Database,
  input: {
    embedding: readonly number[];
    excludedIds: readonly number[];
    universe: readonly CatalogEntry[];
    likedGenres: readonly string[];
  },
): Promise<UserRanking> {
  const pool = await findNearestMovies(db, {
    embedding: input.embedding,
    excludeIds: input.excludedIds,
    limit: EVALUATION_CANDIDATES,
  });
  const showcase = selectDiverse(applyExploration(pool, 0), {
    limit: MAX_RECOMMENDATIONS,
  }).map((pick) => pick.movieId);
  const excluded = new Set(input.excludedIds);
  const eligible = input.universe.filter((entry) => !excluded.has(entry.movieId));

  return {
    showcase,
    popularity: rankByPopularity(eligible, EVALUATION_CANDIDATES),
    genre: rankByGenre(eligible, input.likedGenres, EVALUATION_CANDIDATES),
  };
}
