import { useCallback, useEffect, useRef, useState } from 'react';
import type { MovieCard } from '@movie-recommender/shared';
import { fetchMovie } from './api';
import { formatRating, meanRating, ratingHistogram, recentActivity } from './dashboardStats';
import { downloadTextFile } from './download';
import { createMovieLookup, type MovieLookup } from './movieLookup';
import type { GuestProfile } from './profile/GuestProfile';
import { MAX_HISTORY_ROUNDS, type HistoryEntry, type RatingRecord } from './profile/schema';
import {
  buildLetterboxdCsv,
  buildProfileBackup,
  isoDate,
  ratingRowsForExport,
} from './profileExport';

export interface DashboardProps {
  profile: GuestProfile;
  /** Injected in tests; defaults to createMovieLookup(fetchMovie). */
  lookup?: MovieLookup;
  /** Injected in tests for deterministic dates. */
  now?: () => number;
}

interface DashboardData {
  ratings: RatingRecord[];
  watchedCount: number;
  watchlistIds: number[];
  cooldownCount: number;
  history: HistoryEntry[];
}

const LOAD_ERROR_MESSAGE = 'Could not load your dashboard. Try again.';
const REMOVE_RATING_ERROR_MESSAGE = 'Could not remove that rating. Try again.';
const REMOVE_WATCHLIST_ERROR_MESSAGE = 'Could not change your watchlist. Try again.';
const EXPORT_RATINGS_ERROR_MESSAGE = 'Could not export your ratings. Try again.';
const EXPORT_BACKUP_ERROR_MESSAGE = 'Could not export your backup. Try again.';
const DELETE_PROFILE_ERROR_MESSAGE = 'Could not delete your profile. Try again.';

const DELETE_PROFILE_WARNING =
  'This deletes your ratings, watchlist, watched films, cooldowns and recommendation history on this device. It cannot be undone.';

type DataAction = 'ratings' | 'backup' | 'delete';

const DATA_ACTION_ERROR_MESSAGES: Record<DataAction, string> = {
  ratings: EXPORT_RATINGS_ERROR_MESSAGE,
  backup: EXPORT_BACKUP_ERROR_MESSAGE,
  delete: DELETE_PROFILE_ERROR_MESSAGE,
};

/** The ledger shows the newest rounds; stats still read everything retained. */
const RECENT_HISTORY_LIMIT = 10;

const EMPTY_RATINGS_MESSAGE = 'No ratings yet. Rate a film in your library to tune the picks.';
const EMPTY_WATCHLIST_MESSAGE = 'Nothing on your watchlist yet.';
const EMPTY_HISTORY_MESSAGE = 'No picks yet. Your recommendation rounds will appear here.';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const SOURCE_LABELS: Record<HistoryEntry['source'], string> = {
  catalog: 'Whole catalog',
  watchlist: 'Watchlist',
  rewatch: 'Rewatch shortlist',
  paste: 'Pasted list',
};

const KIND_LABELS: Record<HistoryEntry['kind'], string> = {
  round: 'Round',
  replace: 'Replacement',
  refresh: 'Refresh',
};

/** Local wall-clock time with a fixed month list, independent of locale settings. */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const month = MONTH_NAMES[date.getMonth()];

  if (month === undefined) {
    return 'Unknown date';
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${String(date.getDate())} ${month} ${String(date.getFullYear())}, ${hours}:${minutes}`;
}

function ratingLabel(rating: number): string {
  return `${rating} ${rating === 1 ? 'star' : 'stars'}`;
}

function countLabel(count: number): string {
  return `${count} rated ${count === 1 ? 'film' : 'films'}`;
}

function exportedRatingsMessage(count: number, skipped: number): string {
  const exported = `Exported ${String(count)} ${count === 1 ? 'rating' : 'ratings'}.`;

  if (skipped === 0) {
    return exported;
  }

  return `${exported} ${String(skipped)} ${
    skipped === 1 ? 'film' : 'films'
  } could not be looked up and were left out.`;
}

function activityLabel(rounds: number, replacements: number): string {
  return `${rounds} ${rounds === 1 ? 'round' : 'rounds'} and ${replacements} ${
    replacements === 1 ? 'replacement' : 'replacements'
  } in the last 7 days`;
}

function histogramBarWidth(count: number, maxCount: number): string {
  return maxCount === 0 ? '0%' : `${Math.round((count / maxCount) * 100)}%`;
}

/** One row per rated film, newest rating first, so duplicates cannot render twice. */
function ratedFilmsByRecency(ratings: readonly RatingRecord[]): RatingRecord[] {
  const latestByMovieId = new Map<number, RatingRecord>();

  for (const record of ratings) {
    const existing = latestByMovieId.get(record.movieId);

    if (existing === undefined || record.updatedAt >= existing.updatedAt) {
      latestByMovieId.set(record.movieId, record);
    }
  }

  return [...latestByMovieId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.movieId - right.movieId,
  );
}

/**
 * The rejected film can only appear in a round recorded before the replacement,
 * so newer entries are never consulted. The highest older id is the round it left.
 */
function replacedMovieLabel(entry: HistoryEntry, history: readonly HistoryEntry[]): string | null {
  if (entry.kind !== 'replace') {
    return null;
  }

  const replacedMovieId = entry.replacedMovieId;

  if (replacedMovieId === null) {
    return 'Replaced one pick';
  }

  let bestId = 0;
  let bestTitle: string | null = null;

  for (const candidate of history) {
    if (candidate.id >= entry.id || candidate.id <= bestId) {
      continue;
    }

    const snapshot = candidate.movies.find((movie) => movie.id === replacedMovieId);

    if (snapshot !== undefined) {
      bestId = candidate.id;
      bestTitle = snapshot.title;
    }
  }

  return bestTitle === null ? 'Replaced one pick' : `Replaced ${bestTitle}`;
}

export function Dashboard({ profile, lookup, now = Date.now }: DashboardProps) {
  const [defaultLookup] = useState(() => createMovieLookup(fetchMovie));
  const movieLookup = lookup ?? defaultLookup;
  const [data, setData] = useState<DashboardData | null>(null);
  const [titles, setTitles] = useState<ReadonlyMap<number, MovieCard | null>>(() => new Map());
  const [loadFailed, setLoadFailed] = useState(false);
  const [removeRatingError, setRemoveRatingError] = useState<string | null>(null);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [dataAction, setDataAction] = useState<DataAction | null>(null);
  const [dataStatus, setDataStatus] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dataActionInFlight = useRef(false);
  const loadId = useRef(0);

  const loadDashboard = useCallback(async (): Promise<void> => {
    loadId.current += 1;
    const currentLoadId = loadId.current;

    // Rows fall back to "Movie #<id>" until the new batch resolves; a rejected
    // batch must not leave titles from an earlier load on screen.
    setTitles(new Map());

    try {
      const [ratings, watchedIds, watchlistIds, cooldownIds, history] = await Promise.all([
        profile.getRatings(),
        profile.getWatchedIds(),
        profile.getWatchlistIds(),
        profile.getActiveCooldownIds(),
        profile.getHistory(MAX_HISTORY_ROUNDS),
      ]);

      if (loadId.current !== currentLoadId) {
        return;
      }

      setData({
        ratings,
        watchedCount: watchedIds.length,
        watchlistIds,
        cooldownCount: cooldownIds.length,
        history,
      });
      setLoadFailed(false);

      const ids = [...ratings.map((record) => record.movieId), ...watchlistIds];

      try {
        const resolved = await movieLookup.resolveMany(ids);

        if (loadId.current === currentLoadId) {
          setTitles(resolved);
        }
      } catch {
        // Rows keep their "Movie #<id>" fallback; a failed lookup is not a load failure.
      }
    } catch {
      if (loadId.current === currentLoadId) {
        setLoadFailed(true);
      }
    }
  }, [profile, movieLookup]);

  useEffect(() => {
    void loadDashboard();

    return () => {
      loadId.current += 1;
    };
  }, [loadDashboard]);

  async function removeRating(movieId: number): Promise<void> {
    setRemoveRatingError(null);

    try {
      await profile.removeRating(movieId);
    } catch {
      setRemoveRatingError(REMOVE_RATING_ERROR_MESSAGE);
      return;
    }

    await loadDashboard();
  }

  async function removeFromWatchlist(movieId: number): Promise<void> {
    setWatchlistError(null);

    try {
      await profile.removeFromWatchlist(movieId);
    } catch {
      setWatchlistError(REMOVE_WATCHLIST_ERROR_MESSAGE);
      return;
    }

    await loadDashboard();
  }

  /**
   * One guard for every "Your data" action: a second click while storage is
   * being read or a download is starting must not run the action twice.
   */
  async function runDataAction(action: DataAction, task: () => Promise<string>): Promise<void> {
    if (dataActionInFlight.current) {
      return;
    }

    dataActionInFlight.current = true;
    setDataAction(action);
    setDataStatus(null);
    setDataError(null);

    try {
      setDataStatus(await task());
    } catch {
      setDataError(DATA_ACTION_ERROR_MESSAGES[action]);
    } finally {
      dataActionInFlight.current = false;
      setDataAction(null);
    }
  }

  async function exportRatings(): Promise<void> {
    await runDataAction('ratings', async () => {
      const ratings = await profile.getRatings();
      const cards = await movieLookup.resolveMany(ratings.map((record) => record.movieId));
      const { rows, skipped } = ratingRowsForExport(ratings, cards);
      const timestamp = now();

      downloadTextFile(
        `letterboxd-ratings-${isoDate(timestamp)}.csv`,
        buildLetterboxdCsv(rows),
        'text/csv',
      );

      return exportedRatingsMessage(rows.length, skipped);
    });
  }

  async function exportBackup(): Promise<void> {
    await runDataAction('backup', async () => {
      const [ratings, watched, watchlist, cooldowns, history] = await Promise.all([
        profile.getRatings(),
        profile.getWatched(),
        profile.getWatchlist(),
        profile.getCooldowns(),
        profile.getHistory(MAX_HISTORY_ROUNDS),
      ]);
      const timestamp = now();

      downloadTextFile(
        `movie-recommender-backup-${isoDate(timestamp)}.json`,
        buildProfileBackup({ ratings, watched, watchlist, cooldowns, history }, timestamp),
        'application/json',
      );

      return 'Exported your backup.';
    });
  }

  async function deleteProfile(): Promise<void> {
    await runDataAction('delete', async () => {
      await profile.clearAll();
      setConfirmingDelete(false);
      await loadDashboard();

      return 'Your profile was deleted.';
    });
  }

  function titleFor(movieId: number): string {
    return titles.get(movieId)?.title ?? `Movie #${String(movieId)}`;
  }

  function yearFor(movieId: number): number | null {
    return titles.get(movieId)?.releaseYear ?? null;
  }

  const ratedFilms = data === null ? [] : ratedFilmsByRecency(data.ratings);
  const histogram = ratingHistogram(ratedFilms);
  const maxCount = histogram.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  const mean = data === null ? null : meanRating(ratedFilms);
  const activity =
    data === null ? { rounds: 0, replacements: 0 } : recentActivity(data.history, now());
  const recentHistory = data === null ? [] : data.history.slice(0, RECENT_HISTORY_LIMIT);

  return (
    <section className="dashboard" aria-labelledby="dashboard-heading">
      <h2 className="dashboard__heading" id="dashboard-heading">
        Your dashboard
      </h2>

      {loadFailed && <p className="status status--error">{LOAD_ERROR_MESSAGE}</p>}

      {data !== null && (
        <>
          <ul className="dashboard__counts">
            <li className="dashboard__count">
              <span className="dashboard__count-value">{String(ratedFilms.length)}</span> rated
            </li>
            <li className="dashboard__count">
              <span className="dashboard__count-value">{String(data.watchedCount)}</span> watched
            </li>
            <li className="dashboard__count">
              <span className="dashboard__count-value">{String(data.watchlistIds.length)}</span>{' '}
              watchlisted
            </li>
            <li className="dashboard__count">
              <span className="dashboard__count-value">{String(data.cooldownCount)}</span> cooling
              down
            </li>
          </ul>

          <p className="dashboard__summary">
            {mean === null ? (
              'No ratings yet'
            ) : (
              <>
                Mean rating <span className="dashboard__mean">{mean.toFixed(1)}</span>
              </>
            )}
            {', '}
            {activityLabel(activity.rounds, activity.replacements)}
          </p>

          <section className="dashboard__panel" aria-labelledby="dashboard-histogram-heading">
            <h3 className="dashboard__section-heading" id="dashboard-histogram-heading">
              Rating spread
            </h3>
            <ul className="dashboard__histogram">
              {histogram.map((bucket) => (
                <li className="dashboard__histogram-row" key={bucket.rating}>
                  <span className="dashboard__histogram-label">
                    {`${ratingLabel(bucket.rating)}: `}
                  </span>
                  <span className="dashboard__histogram-track" aria-hidden="true">
                    <span
                      className="dashboard__histogram-bar"
                      style={{ width: histogramBarWidth(bucket.count, maxCount) }}
                    />
                  </span>
                  <span className="dashboard__histogram-count">{countLabel(bucket.count)}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="dashboard__columns">
            <section className="dashboard__panel" aria-labelledby="dashboard-ratings-heading">
              <h3 className="dashboard__section-heading" id="dashboard-ratings-heading">
                Rated films
              </h3>

              {removeRatingError !== null && (
                <p className="status status--error">{removeRatingError}</p>
              )}

              {ratedFilms.length === 0 ? (
                <p className="dashboard__empty">{EMPTY_RATINGS_MESSAGE}</p>
              ) : (
                <ul className="dashboard__rows">
                  {ratedFilms.map((record) => {
                    const title = titleFor(record.movieId);
                    const year = yearFor(record.movieId);

                    return (
                      <li className="dashboard__row" key={record.movieId}>
                        <span className="dashboard__row-film">
                          <span className="dashboard__row-title">{title}</span>
                          {year !== null && <span className="dashboard__row-year">{year}</span>}
                        </span>
                        <span className="dashboard__row-rating">
                          {`${formatRating(record.rating)} / 5`}
                        </span>
                        <button
                          type="button"
                          className="dashboard__remove"
                          aria-label={`Remove rating for ${title}`}
                          onClick={() => {
                            void removeRating(record.movieId);
                          }}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="dashboard__panel" aria-labelledby="dashboard-watchlist-heading">
              <h3 className="dashboard__section-heading" id="dashboard-watchlist-heading">
                Watchlist
              </h3>

              {watchlistError !== null && <p className="status status--error">{watchlistError}</p>}

              {data.watchlistIds.length === 0 ? (
                <p className="dashboard__empty">{EMPTY_WATCHLIST_MESSAGE}</p>
              ) : (
                <ul className="dashboard__rows">
                  {data.watchlistIds.map((movieId) => {
                    const title = titleFor(movieId);
                    const year = yearFor(movieId);

                    return (
                      <li className="dashboard__row" key={movieId}>
                        <span className="dashboard__row-film">
                          <span className="dashboard__row-title">{title}</span>
                          {year !== null && <span className="dashboard__row-year">{year}</span>}
                        </span>
                        <button
                          type="button"
                          className="dashboard__remove"
                          aria-label={`Remove ${title} from watchlist`}
                          onClick={() => {
                            void removeFromWatchlist(movieId);
                          }}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <section className="dashboard__panel" aria-labelledby="dashboard-history-heading">
            <h3 className="dashboard__section-heading" id="dashboard-history-heading">
              Recent picks
            </h3>

            {recentHistory.length === 0 ? (
              <p className="dashboard__empty">{EMPTY_HISTORY_MESSAGE}</p>
            ) : (
              <ol className="dashboard__history">
                {recentHistory.map((entry) => {
                  const replaced = replacedMovieLabel(entry, data.history);

                  return (
                    <li className="dashboard__history-entry" key={entry.id}>
                      <p className="dashboard__history-meta">
                        <span>{formatTimestamp(entry.createdAt)}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{SOURCE_LABELS[entry.source]}</span>
                        {entry.prompt !== '' && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>{`"${entry.prompt}"`}</span>
                          </>
                        )}
                        <span aria-hidden="true"> · </span>
                        <span>{KIND_LABELS[entry.kind]}</span>
                      </p>
                      {replaced !== null && (
                        <p className="dashboard__history-replaced">{replaced}</p>
                      )}
                      <p className="dashboard__history-picks">
                        {entry.movies.map((movie) => movie.title).join(' · ')}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="dashboard__panel" aria-labelledby="dashboard-data-heading">
            <h3 className="dashboard__section-heading" id="dashboard-data-heading">
              Your data
            </h3>

            <div className="dashboard__data-actions">
              <button
                type="button"
                className="dashboard__data-action"
                disabled={dataAction !== null || ratedFilms.length === 0}
                onClick={() => {
                  void exportRatings();
                }}
              >
                Export ratings (CSV)
              </button>
              <button
                type="button"
                className="dashboard__data-action"
                disabled={dataAction !== null}
                onClick={() => {
                  void exportBackup();
                }}
              >
                Export backup (JSON)
              </button>
              {!confirmingDelete && (
                <button
                  type="button"
                  className="dashboard__data-action"
                  disabled={dataAction !== null}
                  onClick={() => {
                    setConfirmingDelete(true);
                  }}
                >
                  Delete profile
                </button>
              )}
            </div>

            {confirmingDelete && (
              <div className="dashboard__data-confirm">
                <p className="dashboard__data-warning" id="dashboard-delete-warning">
                  {DELETE_PROFILE_WARNING}
                </p>
                <div className="dashboard__data-actions">
                  <button
                    type="button"
                    className="dashboard__data-action dashboard__data-action--destructive"
                    disabled={dataAction !== null}
                    autoFocus
                    aria-describedby="dashboard-delete-warning"
                    onClick={() => {
                      void deleteProfile();
                    }}
                  >
                    Delete everything
                  </button>
                  <button
                    type="button"
                    className="dashboard__data-action"
                    disabled={dataAction !== null}
                    onClick={() => {
                      setConfirmingDelete(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <p
              className={
                dataError === null
                  ? 'status dashboard__data-status'
                  : 'status status--error dashboard__data-status'
              }
              role="status"
            >
              {dataError ?? dataStatus ?? ''}
            </p>
          </section>
        </>
      )}
    </section>
  );
}
