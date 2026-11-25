import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MovieCard } from '@movie-recommender/shared';
import { RecommendationApiError, RecommendationNetworkError, searchMovies } from './api';
import { LetterboxdImport } from './LetterboxdImport';
import { ratingFromHalfStarPosition, starFill } from './libraryRatings';
import type { GuestProfile } from './profile/GuestProfile';

type SearchState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'results'; movies: MovieCard[] }
  | { status: 'error'; message: string };

const STARS = [1, 2, 3, 4, 5] as const;
const HALF_STARS = [0, 1] as const;

const SEARCH_ERROR_MESSAGE = 'Something went wrong while searching. Try again.';
const LOAD_ERROR_MESSAGE = 'Could not load your library. Try again.';
const WRITE_ERROR_MESSAGE = 'Could not save your library change. Try again.';

function searchErrorMessage(error: unknown): string {
  if (error instanceof RecommendationApiError || error instanceof RecommendationNetworkError) {
    return error.message;
  }

  return SEARCH_ERROR_MESSAGE;
}

function ratingLabel(rating: number): string {
  return `${rating} ${rating === 1 ? 'star' : 'stars'} out of 5`;
}

function toggledIds(ids: ReadonlySet<number>, movieId: number, present: boolean): Set<number> {
  const next = new Set(ids);

  if (present) {
    next.add(movieId);
  } else {
    next.delete(movieId);
  }

  return next;
}

interface RatingControlProps {
  movieId: number;
  title: string;
  rating: number | undefined;
  onSelect: (rating: number) => void;
}

function RatingControl({ movieId, title, rating, onSelect }: RatingControlProps) {
  return (
    <div className="star-rating" role="radiogroup" aria-label={`Rating for ${title}`}>
      {STARS.map((star) => {
        const fill = starFill(rating ?? 0, star);

        return (
          <span className="star-rating__star" key={star}>
            <span className="star-rating__glyph" aria-hidden="true">
              ★
            </span>
            {fill !== 'empty' && (
              <span className={`star-rating__fill star-rating__fill--${fill}`} aria-hidden="true">
                ★
              </span>
            )}
            {HALF_STARS.map((side) => {
              const value = ratingFromHalfStarPosition((star - 1) * 2 + side + 1);

              return (
                <input
                  key={side}
                  type="radio"
                  className={`star-rating__input star-rating__input--${
                    side === 0 ? 'left' : 'right'
                  }`}
                  name={`rating-${movieId}`}
                  value={value}
                  checked={rating === value}
                  aria-label={ratingLabel(value)}
                  onChange={() => onSelect(value)}
                />
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

export function Library({ profile }: { profile: GuestProfile }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const [ratings, setRatings] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [watchedIds, setWatchedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [watchlistIds, setWatchlistIds] = useState<ReadonlySet<number>>(() => new Set());
  const [writeError, setWriteError] = useState<string | null>(null);
  const searchId = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [ratingRecords, watched, watchlist] = await Promise.all([
          profile.getRatings(),
          profile.getWatchedIds(),
          profile.getWatchlistIds(),
        ]);

        if (cancelled) {
          return;
        }

        setRatings(new Map(ratingRecords.map((record) => [record.movieId, record.rating])));
        setWatchedIds(new Set(watched));
        setWatchlistIds(new Set(watchlist));
      } catch {
        if (!cancelled) {
          setWriteError(LOAD_ERROR_MESSAGE);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [profile]);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (search.status === 'pending') {
      return;
    }

    const trimmedQuery = query.trim();

    if (trimmedQuery === '') {
      setSearch({ status: 'idle' });
      return;
    }

    searchId.current += 1;
    const currentSearchId = searchId.current;

    setWriteError(null);
    setSearch({ status: 'pending' });

    try {
      const movies = await searchMovies(trimmedQuery);

      if (searchId.current === currentSearchId) {
        setSearch({ status: 'results', movies });
      }
    } catch (error) {
      if (searchId.current === currentSearchId) {
        setSearch({ status: 'error', message: searchErrorMessage(error) });
      }
    }
  }

  async function handleRate(movieId: number, rating: number) {
    setWriteError(null);

    try {
      await profile.setRating(movieId, rating);
      setRatings((previous) => new Map(previous).set(movieId, rating));
    } catch {
      setWriteError(WRITE_ERROR_MESSAGE);
    }
  }

  async function handleWatchedToggle(movieId: number) {
    const watched = watchedIds.has(movieId);

    setWriteError(null);

    try {
      if (watched) {
        await profile.removeWatched(movieId);
      } else {
        await profile.setWatched(movieId);
      }

      setWatchedIds((previous) => toggledIds(previous, movieId, !watched));
    } catch {
      setWriteError(WRITE_ERROR_MESSAGE);
    }
  }

  async function handleWatchlistToggle(movieId: number) {
    const watchlisted = watchlistIds.has(movieId);

    setWriteError(null);

    try {
      if (watchlisted) {
        await profile.removeFromWatchlist(movieId);
      } else {
        await profile.addToWatchlist(movieId);
      }

      setWatchlistIds((previous) => toggledIds(previous, movieId, !watchlisted));
    } catch {
      setWriteError(WRITE_ERROR_MESSAGE);
    }
  }

  return (
    <section className="library" aria-labelledby="library-heading">
      <div className="section-head">
        <h2 className="library__heading" id="library-heading">
          Your library
        </h2>
        <p className="library__intro">
          Rate films you have seen to tune the picks. Watched films are left out of recommendations.
        </p>
      </div>

      <div className="library__tools">
        <form className="library__search" onSubmit={handleSearch}>
          <label htmlFor="library-search">Find a film to rate</label>
          <div className="library__search-controls">
            <input
              id="library-search"
              type="search"
              maxLength={80}
              autoComplete="off"
              placeholder="Search the catalog…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" disabled={search.status === 'pending'}>
              {search.status === 'pending' ? 'Searching…' : 'Search'}
            </button>
          </div>
        </form>

        <LetterboxdImport
          profile={profile}
          onRatingImported={(movieId, rating) => {
            setRatings((previous) => new Map(previous).set(movieId, rating));
          }}
          onWatchedImported={(movieId) => {
            setWatchedIds((previous) => toggledIds(previous, movieId, true));
          }}
          onWatchlistImported={(movieId) => {
            setWatchlistIds((previous) => toggledIds(previous, movieId, true));
          }}
        />
      </div>

      {writeError !== null && <p className="status status--error">{writeError}</p>}
      {search.status === 'error' && <p className="status status--error">{search.message}</p>}
      {search.status === 'pending' && <p className="status">Searching the catalog…</p>}

      {search.status === 'results' &&
        (search.movies.length === 0 ? (
          <p className="status">No films matched that search.</p>
        ) : (
          <>
            <p className="library__results-label">
              {`${String(search.movies.length)} ${
                search.movies.length === 1 ? 'film' : 'films'
              } found`}
            </p>
            <ul className="library__results" aria-label="Search results">
              {search.movies.map((movie) => {
                const watched = watchedIds.has(movie.id);
                const watchlisted = watchlistIds.has(movie.id);

                return (
                  <li className="library__row" key={movie.id}>
                    <div className="library__film">
                      <h3 className="library__title">{movie.title}</h3>
                      {movie.releaseYear !== null && (
                        <p className="library__year">{movie.releaseYear}</p>
                      )}
                    </div>
                    <div className="library__controls">
                      <RatingControl
                        movieId={movie.id}
                        title={movie.title}
                        rating={ratings.get(movie.id)}
                        onSelect={(rating) => {
                          void handleRate(movie.id, rating);
                        }}
                      />
                      <div className="library__toggles">
                        <button
                          type="button"
                          className="library__toggle"
                          aria-pressed={watched}
                          aria-label={`${movie.title}: watched`}
                          onClick={() => {
                            void handleWatchedToggle(movie.id);
                          }}
                        >
                          Watched
                        </button>
                        <button
                          type="button"
                          className="library__toggle"
                          aria-pressed={watchlisted}
                          aria-label={`${movie.title}: watchlist`}
                          onClick={() => {
                            void handleWatchlistToggle(movie.id);
                          }}
                        >
                          Watchlist
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ))}
    </section>
  );
}
