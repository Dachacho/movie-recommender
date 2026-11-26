import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MovieCard } from '@movie-recommender/shared';
import {
  fetchMovie,
  RecommendationApiError,
  RecommendationNetworkError,
  searchMovies,
} from './api';
import { formatRating } from './dashboardStats';
import { LetterboxdImport } from './LetterboxdImport';
import { ratingFromHalfStarPosition, starFill } from './libraryRatings';
import { createMovieLookup, type MovieLookup } from './movieLookup';
import type { GuestProfile } from './profile/GuestProfile';

export type LibraryTab = 'rated' | 'watchlist' | 'find';

type SearchState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'results'; movies: MovieCard[] }
  | { status: 'error'; message: string };

const STARS = [1, 2, 3, 4, 5] as const;
const HALF_STARS = [0, 1] as const;
const PAGE_SIZE = 12;

const SEARCH_ERROR_MESSAGE = 'Something went wrong while searching. Try again.';
const LOAD_ERROR_MESSAGE = 'Could not load your library. Try again.';
const WRITE_ERROR_MESSAGE = 'Could not save your library change. Try again.';

interface RatedEntry {
  movieId: number;
  rating: number;
}

interface TitleBatch {
  /** Ids the batch was requested for, joined; null before the first request. */
  key: string | null;
  settled: boolean;
  movies: ReadonlyMap<number, MovieCard | null>;
}

interface RowFocusRequest {
  /** Tab that owned the removed row; a later tab change drops the request. */
  tab: 'rated' | 'watchlist';
  /** Neighbouring row to land on after the removal; null when none existed. */
  neighborMovieId: number | null;
}

function TitlePlaceholder() {
  return <span className="title-skeleton" aria-hidden="true" />;
}

/** Rating first, then movieId, so equal ratings keep a stable catalog order. */
function ratedEntries(ratings: ReadonlyMap<number, number>): RatedEntry[] {
  return [...ratings.entries()]
    .map(([movieId, rating]) => ({ movieId, rating }))
    .sort((left, right) => right.rating - left.rating || left.movieId - right.movieId);
}

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

interface PagerProps {
  page: number;
  totalPages: number;
  onPrevious: () => void;
  onNext: () => void;
}

function Pager({ page, totalPages, onPrevious, onNext }: PagerProps) {
  return (
    <div className="library__pager">
      <button
        type="button"
        className="button--secondary"
        disabled={page === 0}
        onClick={onPrevious}
      >
        Previous
      </button>
      <p className="library__pager-status" aria-live="polite">
        {`Page ${String(page + 1)} of ${String(totalPages)}`}
      </p>
      <button
        type="button"
        className="button--secondary"
        disabled={page >= totalPages - 1}
        onClick={onNext}
      >
        Next
      </button>
    </div>
  );
}

export interface LibraryProps {
  profile: GuestProfile;
  tab?: LibraryTab;
  /** Injected in tests; defaults to createMovieLookup(fetchMovie). */
  lookup?: MovieLookup;
}

export function Library({ profile, tab = 'rated', lookup }: LibraryProps) {
  const [defaultLookup] = useState(() => createMovieLookup(fetchMovie));
  const movieLookup = lookup ?? defaultLookup;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const [ratings, setRatings] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [watchedIds, setWatchedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [watchlistIds, setWatchlistIds] = useState<ReadonlySet<number>>(() => new Set());
  const [titleBatch, setTitleBatch] = useState<TitleBatch>(() => ({
    key: null,
    settled: false,
    movies: new Map(),
  }));
  const [page, setPage] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [rowFocus, setRowFocus] = useState<RowFocusRequest | null>(null);
  const collectionRef = useRef<HTMLUListElement | null>(null);
  const emptyActionRef = useRef<HTMLAnchorElement | null>(null);
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

  // Every tab starts at its first page; leaving a tab must not strand the pager.
  useEffect(() => {
    setPage(0);
  }, [tab]);

  const rated = ratedEntries(ratings);
  const watchlist = [...watchlistIds].sort((left, right) => left - right);
  const activeCount = tab === 'rated' ? rated.length : tab === 'watchlist' ? watchlist.length : 0;
  const totalPages = Math.max(1, Math.ceil(activeCount / PAGE_SIZE));

  // A list that shrank past the current page falls back to the first page.
  useEffect(() => {
    if (page * PAGE_SIZE >= activeCount) {
      setPage(0);
    }
  }, [activeCount, page]);

  // Resolve only the visible page, never the whole profile: a large library
  // must not fan out one title request per rated film. The source collections
  // stay in the dependency list as stable maps/sets; ordered arrays would be
  // rebuilt on every titles update and retrigger this effect.
  useEffect(() => {
    if (tab === 'find') {
      return;
    }

    const orderedIds =
      tab === 'watchlist'
        ? [...watchlistIds].sort((left, right) => left - right)
        : ratedEntries(ratings).map((entry) => entry.movieId);
    const ids = orderedIds.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const key = ids.join(',');

    if (ids.length === 0) {
      setTitleBatch({ key, settled: true, movies: new Map() });
      return;
    }

    // A batch already resolved for these ids keeps its titles; a new key
    // starts settled: false so rows shimmer instead of flashing "Movie #".
    setTitleBatch((previous) =>
      previous.key === key && previous.settled
        ? previous
        : { key, settled: false, movies: new Map() },
    );

    let cancelled = false;

    void movieLookup.resolveMany(ids).then(
      (resolved) => {
        if (!cancelled) {
          setTitleBatch({ key, settled: true, movies: resolved });
        }
      },
      () => {
        if (!cancelled) {
          setTitleBatch({ key, settled: true, movies: new Map() });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [movieLookup, page, ratings, tab, watchlistIds]);

  // A removed row takes the focused button with it. Once the new rows render,
  // land on the next row's control, else the previous row's, else the action
  // that now stands in for the empty collection. Matching by movie id also
  // waits for the pager reset when the last row of a later page was removed.
  // A removal that finishes after a tab change is dropped: the guest already
  // moved on, so focus must not jump into the new collection.
  useEffect(() => {
    if (rowFocus === null) {
      return;
    }

    if (rowFocus.tab !== tab) {
      setRowFocus(null);
      return;
    }

    const remaining = rowFocus.tab === 'rated' ? ratings.size : watchlistIds.size;

    if (remaining === 0) {
      emptyActionRef.current?.focus();
      setRowFocus(null);
      return;
    }

    const neighborId = rowFocus.neighborMovieId;

    if (neighborId === null) {
      setRowFocus(null);
      return;
    }

    const rows = collectionRef.current?.querySelectorAll<HTMLLIElement>('li') ?? [];
    const row = [...rows].find((item) => item.dataset.movieId === String(neighborId));
    const control = row?.querySelector('button');

    if (control instanceof HTMLButtonElement) {
      control.focus();
      setRowFocus(null);
    }
  }, [page, ratings.size, rowFocus, tab, watchlistIds.size]);

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

  async function handleClearRating(movieId: number, neighborMovieId?: number | null) {
    setWriteError(null);

    try {
      await profile.removeRating(movieId);
      setRatings((previous) => {
        const next = new Map(previous);

        next.delete(movieId);

        return next;
      });

      // Search-result rows stay mounted, so only a removed collection row
      // needs the focus hand-off.
      if (neighborMovieId !== undefined) {
        setRowFocus({ tab: 'rated', neighborMovieId });
      }
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

  async function handleRemoveFromWatchlist(movieId: number, neighborMovieId: number | null) {
    setWriteError(null);

    try {
      await profile.removeFromWatchlist(movieId);
      setWatchlistIds((previous) => toggledIds(previous, movieId, false));
      setRowFocus({ tab: 'watchlist', neighborMovieId });
    } catch {
      setWriteError(WRITE_ERROR_MESSAGE);
    }
  }

  const visibleRated = rated.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const visibleWatchlist = watchlist.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const visibleIds =
    tab === 'rated'
      ? visibleRated.map((entry) => entry.movieId)
      : tab === 'watchlist'
        ? visibleWatchlist
        : [];
  const titlesSettled = titleBatch.key === visibleIds.join(',') && titleBatch.settled;

  /** Null while the visible batch is still resolving; a known miss falls back. */
  function titleFor(movieId: number): string | null {
    if (!titlesSettled) {
      return null;
    }

    return titleBatch.movies.get(movieId)?.title ?? `Movie #${String(movieId)}`;
  }

  function yearFor(movieId: number): number | null {
    if (!titlesSettled) {
      return null;
    }

    return titleBatch.movies.get(movieId)?.releaseYear ?? null;
  }

  return (
    <section className="library" aria-labelledby="library-heading">
      <div className="section-head">
        <h2 className="library__heading" id="library-heading">
          Your library
        </h2>
        <p className="library__intro">
          Everything you've rated and saved, plus a search to add more.
        </p>
      </div>

      <nav className="library__tabs" aria-label="Library sections">
        <a href="#library/rated" aria-current={tab === 'rated' ? 'page' : undefined}>
          Rated <span className="library__tab-count">{String(ratings.size)}</span>
        </a>
        <a href="#library/watchlist" aria-current={tab === 'watchlist' ? 'page' : undefined}>
          Watchlist <span className="library__tab-count">{String(watchlistIds.size)}</span>
        </a>
        <a href="#library/find" aria-current={tab === 'find' ? 'page' : undefined}>
          Find films
        </a>
      </nav>

      {writeError !== null && <p className="status status--error">{writeError}</p>}

      {tab === 'rated' && (
        <div className="library__collection">
          {rated.length === 0 ? (
            <div className="library__empty">
              <p className="library__empty-title">No rated films yet.</p>
              <p className="library__empty-copy">
                Rate a few films and the picks start to follow your taste.
              </p>
              <div className="library__empty-actions">
                <a className="button--secondary" ref={emptyActionRef} href="#library/find">
                  Find films to rate
                </a>
              </div>
            </div>
          ) : (
            <>
              <ul
                className="library__results"
                aria-label="Rated films"
                aria-busy={!titlesSettled}
                ref={collectionRef}
              >
                {visibleRated.map((entry, index) => {
                  const title = titleFor(entry.movieId);
                  const year = yearFor(entry.movieId);
                  const orderedIndex = page * PAGE_SIZE + index;
                  const neighborMovieId =
                    rated[orderedIndex + 1]?.movieId ?? rated[orderedIndex - 1]?.movieId ?? null;

                  return (
                    <li className="library__row" key={entry.movieId} data-movie-id={entry.movieId}>
                      <div className="library__film">
                        <h3 className="library__title">
                          {title === null ? <TitlePlaceholder /> : title}
                        </h3>
                        {year !== null && <p className="library__year">{year}</p>}
                      </div>
                      <div className="library__controls">
                        <p className="library__rating">{`${formatRating(entry.rating)} / 5`}</p>
                        <button
                          type="button"
                          className="button--ghost"
                          aria-label={`Remove rating for ${title ?? 'this film'}`}
                          onClick={() => {
                            void handleClearRating(entry.movieId, neighborMovieId);
                          }}
                        >
                          Remove rating
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {activeCount > PAGE_SIZE && (
                <Pager
                  page={page}
                  totalPages={totalPages}
                  onPrevious={() => {
                    setPage((current) => Math.max(0, current - 1));
                  }}
                  onNext={() => {
                    setPage((current) => Math.min(totalPages - 1, current + 1));
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      {tab === 'watchlist' && (
        <div className="library__collection">
          {watchlist.length === 0 ? (
            <div className="library__empty">
              <p className="library__empty-title">Nothing saved yet.</p>
              <p className="library__empty-copy">Save a film and it stays here for later.</p>
              <div className="library__empty-actions">
                <a className="button--secondary" ref={emptyActionRef} href="#library/find">
                  Find films to save
                </a>
              </div>
            </div>
          ) : (
            <>
              <ul
                className="library__results"
                aria-label="Watchlist films"
                aria-busy={!titlesSettled}
                ref={collectionRef}
              >
                {visibleWatchlist.map((movieId, index) => {
                  const title = titleFor(movieId);
                  const year = yearFor(movieId);
                  const orderedIndex = page * PAGE_SIZE + index;
                  const neighborMovieId =
                    watchlist[orderedIndex + 1] ?? watchlist[orderedIndex - 1] ?? null;

                  return (
                    <li className="library__row" key={movieId} data-movie-id={movieId}>
                      <div className="library__film">
                        <h3 className="library__title">
                          {title === null ? <TitlePlaceholder /> : title}
                        </h3>
                        {year !== null && <p className="library__year">{year}</p>}
                      </div>
                      <div className="library__controls">
                        <button
                          type="button"
                          className="button--ghost"
                          aria-label={`Remove ${title ?? 'this film'} from watchlist`}
                          onClick={() => {
                            void handleRemoveFromWatchlist(movieId, neighborMovieId);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {activeCount > PAGE_SIZE && (
                <Pager
                  page={page}
                  totalPages={totalPages}
                  onPrevious={() => {
                    setPage((current) => Math.max(0, current - 1));
                  }}
                  onNext={() => {
                    setPage((current) => Math.min(totalPages - 1, current + 1));
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      {tab === 'find' && (
        <>
          <div className="library__tools">
            <form className="library__search" onSubmit={handleSearch}>
              <label htmlFor="library-search">Find a film to rate</label>
              <div className="library__search-controls">
                <input
                  id="library-search"
                  name="library-search"
                  type="search"
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Search the catalog…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button
                  type="submit"
                  className="button--secondary"
                  data-loading={search.status === 'pending' ? 'true' : undefined}
                  disabled={search.status === 'pending'}
                >
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

          {search.status === 'idle' && (
            <div className="library__idle">
              <p className="library__idle-copy">
                Search the catalog to rate a film, mark it watched, or save it for later.
              </p>
              <a className="library__idle-link" href="#dashboard">
                Open your dashboard
              </a>
            </div>
          )}

          {search.status === 'error' && (
            <p className="status status--error" role="alert">
              {search.message}
            </p>
          )}
          {search.status === 'pending' && (
            <p className="status" role="status">
              Searching the catalog…
            </p>
          )}

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
                            {ratings.has(movie.id) && (
                              <button
                                type="button"
                                className="button--ghost"
                                aria-label={`Remove rating for ${movie.title}`}
                                onClick={() => {
                                  void handleClearRating(movie.id);
                                }}
                              >
                                Remove rating
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ))}
        </>
      )}
    </section>
  );
}
