import type { MovieCard } from '@movie-recommender/shared';
import type { Movie } from '../../db/schema.js';

export function toMovieCard(movie: Movie): MovieCard {
  return {
    id: movie.id,
    title: movie.title,
    releaseYear: movie.releaseYear,
    runtime: movie.runtime,
    overview: movie.overview,
    genres: movie.genres ?? [],
    director: movie.director,
    cast: movie.cast ?? [],
    posterPath: movie.posterPath,
    voteAverage: movie.voteAverage,
  };
}
