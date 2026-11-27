export interface TasteFilm {
  movieId: number;
  rating: number;
  genres: readonly string[];
}

export interface TasteGenre {
  genre: string;
  count: number;
  meanRating: number;
  affinity: number;
}

/** An unordered pair; `a` sorts before `b` so each pair has one representation. */
export interface TasteEdge {
  a: string;
  b: string;
  count: number;
}

export interface TasteGraph {
  /** Every genre by film count, then name; the tables and bars read this. */
  allGenres: TasteGenre[];
  /** The genres the constellation plots: the top `maxGenres`. */
  genres: TasteGenre[];
  /** Strongest co-occurrences between any genres, then pair names. */
  edges: TasteEdge[];
  /** Films with at least one genre; films without genres are ignored. */
  filmCount: number;
  meanRating: number;
  /** Distinct genres before the top-genre cap. */
  totalGenres: number;
}

export interface TasteGraphOptions {
  maxGenres?: number;
  maxEdges?: number;
}

const DEFAULT_MAX_GENRES = 12;
const DEFAULT_MAX_EDGES = 24;
const AFFINITY_NEUTRAL_RATING = 2.5;

function capOption(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/** [a, b] with a < b, so reversed duplicates collapse to the same key. */
function pairKey(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

export function buildTasteGraph(
  films: readonly TasteFilm[],
  options: TasteGraphOptions = {},
): TasteGraph {
  const maxGenres = capOption(options.maxGenres, DEFAULT_MAX_GENRES);
  const maxEdges = capOption(options.maxEdges, DEFAULT_MAX_EDGES);

  const totals = new Map<string, { count: number; ratingTotal: number }>();
  const pairCounts = new Map<string, { a: string; b: string; count: number }>();
  let filmCount = 0;
  let ratingTotal = 0;

  for (const film of films) {
    const genres = [...new Set(film.genres)];

    if (genres.length === 0) {
      continue;
    }

    filmCount += 1;
    ratingTotal += film.rating;

    for (const genre of genres) {
      const total = totals.get(genre);

      if (total === undefined) {
        totals.set(genre, { count: 1, ratingTotal: film.rating });
      } else {
        total.count += 1;
        total.ratingTotal += film.rating;
      }
    }

    for (let left = 0; left < genres.length; left += 1) {
      for (let right = left + 1; right < genres.length; right += 1) {
        const first = genres[left];
        const second = genres[right];

        if (first === undefined || second === undefined) {
          continue;
        }

        const [a, b] = pairKey(first, second);
        const key = `${a}\u0000${b}`;
        const pair = pairCounts.get(key);

        if (pair === undefined) {
          pairCounts.set(key, { a, b, count: 1 });
        } else {
          pair.count += 1;
        }
      }
    }
  }

  const allGenres = [...totals.entries()]
    .map(([genre, total]) => {
      const mean = total.ratingTotal / total.count;

      return {
        genre,
        count: total.count,
        meanRating: mean,
        affinity: mean - AFFINITY_NEUTRAL_RATING,
      };
    })
    .sort((left, right) => right.count - left.count || compareNames(left.genre, right.genre));
  const genres = allGenres.slice(0, maxGenres);

  // The constellation filters these pairs down to the nodes it draws, so the
  // strongest pairs among every genre can reach the edge table intact.
  const edges = [...pairCounts.values()]
    .sort(
      (left, right) =>
        right.count - left.count || compareNames(left.a, right.a) || compareNames(left.b, right.b),
    )
    .slice(0, maxEdges);

  return {
    allGenres,
    genres,
    edges,
    filmCount,
    meanRating: filmCount === 0 ? 0 : ratingTotal / filmCount,
    totalGenres: allGenres.length,
  };
}
