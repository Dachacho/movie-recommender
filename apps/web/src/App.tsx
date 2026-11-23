import { useRef, useState, type FormEvent } from 'react';
import type { MovieCard } from '@movie-recommender/shared';
import {
  RecommendationApiError,
  RecommendationNetworkError,
  fetchRecommendations,
  fetchTasteVector,
  type TasteVector,
} from './api';
import { Library } from './Library';
import { createGuestProfile, type GuestProfile, type RatingsPayload } from './profile/GuestProfile';
import {
  buildRecommendationInput,
  buildRefreshAllInput,
  buildReplacementInput,
  mergeReplacement,
} from './recommendationInput';

/**
 * The intent a round was drawn with. The taste vector and prompt stay pinned
 * to the round; hard exclusions are always re-read from the profile so films
 * rated or watched while the picks are on screen are never suggested.
 */
interface RoundIntent {
  tasteVector: TasteVector;
  prompt: string;
}

interface PickRound {
  requestId: number;
  movies: MovieCard[];
  intent: RoundIntent;
}

type ScreenState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'results'; round: PickRound }
  | { status: 'error'; message: string };

type ActionState =
  | { status: 'idle' }
  | { status: 'pending'; kind: 'replace'; index: number }
  | { status: 'pending'; kind: 'refresh' }
  | { status: 'error'; message: string };

interface TasteCache {
  version: number;
  vector: TasteVector;
}

export interface AppProps {
  /** Injected in tests; the app uses a Dexie-backed profile. */
  profile?: GuestProfile;
}

const POSTER_BASE_URL = 'https://image.tmdb.org/t/p/w500';

const REPLACE_ERROR_MESSAGE = 'Could not find another movie. Your picks are unchanged.';
const REFRESH_ERROR_MESSAGE = 'Could not refresh the picks. Your picks are unchanged.';
const EXCLUSION_TRIM_NOTICE =
  'Your library is larger than a single request can exclude — the oldest entries may occasionally reappear.';

async function tasteVectorFor(
  ratings: RatingsPayload,
  version: number,
  cache: TasteCache | null,
  cacheUpdater: (next: TasteCache) => void,
): Promise<TasteVector> {
  if (ratings.length === 0) {
    return null;
  }

  if (cache !== null && cache.version === version) {
    return cache.vector;
  }

  const vector = await fetchTasteVector(ratings);
  cacheUpdater({ version, vector });

  return vector;
}

function posterUrl(posterPath: string): string {
  return `${POSTER_BASE_URL}${posterPath}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof RecommendationApiError || error instanceof RecommendationNetworkError) {
    return error.message;
  }

  return 'Something went wrong while finding a movie. Try again.';
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof RecommendationApiError || error instanceof RecommendationNetworkError) {
    return error.message;
  }

  return fallback;
}

function PosterPlaceholder({ title }: { title: string }) {
  return (
    <div
      className="poster poster--placeholder"
      role="img"
      aria-label={`No poster available for ${title}`}
    >
      <span aria-hidden="true">No poster</span>
    </div>
  );
}

function MoviePoster({ movie }: { movie: MovieCard }) {
  const [failedPosterPath, setFailedPosterPath] = useState<string | null>(null);
  const posterPath = movie.posterPath;

  if (posterPath === null || failedPosterPath === posterPath) {
    return <PosterPlaceholder title={movie.title} />;
  }

  return (
    <img
      className="poster"
      src={posterUrl(posterPath)}
      alt={`Poster for ${movie.title}`}
      onError={() => setFailedPosterPath(posterPath)}
    />
  );
}

interface RejectButtonProps {
  title: string;
  disabled: boolean;
  pending: boolean;
  onReject: () => void;
}

function RejectButton({ title, disabled, pending, onReject }: RejectButtonProps) {
  return (
    <button
      type="button"
      className="pick-action"
      aria-label={`${title}: not tonight`}
      disabled={disabled}
      onClick={onReject}
    >
      {pending ? 'Finding another…' : 'Not tonight'}
    </button>
  );
}

interface MainPickProps {
  movie: MovieCard;
  disabled: boolean;
  pending: boolean;
  onReject: () => void;
}

function MainPick({ movie, disabled, pending, onReject }: MainPickProps) {
  const facts = [
    movie.releaseYear === null ? null : String(movie.releaseYear),
    movie.director === null ? null : `Directed by ${movie.director}`,
    movie.runtime === null ? null : `${movie.runtime} min`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <article className="main-pick" aria-label="Main pick">
      <MoviePoster movie={movie} />
      <div className="main-pick__body">
        <h2 className="main-pick__title">{movie.title}</h2>
        {facts.length > 0 && <p className="main-pick__meta">{facts.join('. ')}</p>}
        {movie.genres.length > 0 && <p className="main-pick__genres">{movie.genres.join(', ')}</p>}
        {movie.overview !== null && movie.overview !== '' && (
          <p className="main-pick__overview">{movie.overview}</p>
        )}
        <div className="main-pick__actions">
          <RejectButton
            title={movie.title}
            disabled={disabled}
            pending={pending}
            onReject={onReject}
          />
        </div>
      </div>
    </article>
  );
}

interface AlternativesProps {
  movies: MovieCard[];
  /** Index of the first alternative within the round's pick list. */
  startIndex: number;
  disabled: boolean;
  pendingIndex: number | null;
  onReject: (index: number) => void;
}

function Alternatives({ movies, startIndex, disabled, pendingIndex, onReject }: AlternativesProps) {
  if (movies.length === 0) {
    return null;
  }

  return (
    <section className="alternatives">
      <h2 className="alternatives__heading">Also worth a look</h2>
      <ul className="alternatives__list" aria-label="Alternatives">
        {movies.map((movie, offset) => {
          const index = startIndex + offset;

          return (
            <li key={movie.id} className="alternative">
              <MoviePoster movie={movie} />
              <h3 className="alternative__title">{movie.title}</h3>
              {movie.releaseYear !== null && (
                <p className="alternative__year">{movie.releaseYear}</p>
              )}
              <div className="alternative__actions">
                <RejectButton
                  title={movie.title}
                  disabled={disabled}
                  pending={pendingIndex === index}
                  onReject={() => onReject(index)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function App({ profile: providedProfile }: AppProps = {}) {
  const [profile] = useState<GuestProfile>(() => providedProfile ?? createGuestProfile());
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const [action, setAction] = useState<ActionState>({ status: 'idle' });
  const [exclusionTrimmed, setExclusionTrimmed] = useState(false);
  const requestId = useRef(0);
  const tasteCache = useRef<TasteCache | null>(null);

  const actionPending = action.status === 'pending';
  const pending = state.status === 'pending';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || actionPending) {
      return;
    }

    requestId.current += 1;
    const currentRequestId = requestId.current;

    setAction({ status: 'idle' });
    setState({ status: 'pending' });

    try {
      const profileVersion = profile.getVersion();
      const [ratings, ratedIds, watchedIds, cooldownIds] = await Promise.all([
        profile.ratingsPayload(),
        profile.getRatedIds(),
        profile.getWatchedIds(),
        profile.getActiveCooldownIds(),
      ]);
      const tasteVector = await tasteVectorFor(
        ratings,
        profileVersion,
        tasteCache.current,
        (next) => {
          tasteCache.current = next;
        },
      );
      const trimmedPrompt = prompt.trim();
      const { request, droppedIds } = buildRecommendationInput({
        ratedIds,
        watchedIds,
        tasteVector,
        prompt: trimmedPrompt,
        cooldownIds,
      });
      const response = await fetchRecommendations(request);

      setExclusionTrimmed(droppedIds.length > 0);
      setState({
        status: 'results',
        round: {
          requestId: currentRequestId,
          movies: response.movies,
          intent: { tasteVector, prompt: trimmedPrompt },
        },
      });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  /**
   * Cooldowns are written only after the replacement request succeeds, so a
   * failed fetch leaves both the screen and the profile untouched. A pick the
   * guest still sees must not be suppressed behind their back.
   */
  async function handleReplace(index: number) {
    if (state.status !== 'results' || actionPending) {
      return;
    }

    const round = state.round;
    const movie = round.movies[index];

    if (movie === undefined) {
      return;
    }

    setAction({ status: 'pending', kind: 'replace', index });

    try {
      // The library stays usable while picks are shown, so exclusions are
      // re-read now: the round's taste vector and prompt stay pinned, but a
      // film rated or watched since then must not come back as a replacement.
      // Rated ids come from the uncapped set, not the 500-entry taste payload.
      const [ratedIds, watchedIds, cooldownIds] = await Promise.all([
        profile.getRatedIds(),
        profile.getWatchedIds(),
        profile.getActiveCooldownIds(),
      ]);
      const { request, droppedIds } = buildReplacementInput({
        ratedIds,
        watchedIds,
        tasteVector: round.intent.tasteVector,
        prompt: round.intent.prompt,
        visibleMovieIds: round.movies.map((pick) => pick.id),
        replacedMovieId: movie.id,
        cooldownIds,
      });
      const response = await fetchRecommendations(request);

      await profile.setCooldown(movie.id);

      setExclusionTrimmed(droppedIds.length > 0);
      setState((previous) =>
        previous.status === 'results'
          ? {
              status: 'results',
              round: {
                ...previous.round,
                movies: mergeReplacement(previous.round.movies, index, response.movies),
              },
            }
          : previous,
      );
      setAction({ status: 'idle' });
    } catch (error) {
      setAction({ status: 'error', message: actionErrorMessage(error, REPLACE_ERROR_MESSAGE) });
    }
  }

  /**
   * Refresh all cools every visible pick and shows the new round as returned,
   * so none of tonight's rejected films can reappear within seven days. The
   * new round excludes all visible picks and fresh rated/watched ids, while
   * keeping the pinned taste vector and prompt of the round being refreshed.
   */
  async function handleRefreshAll() {
    if (state.status !== 'results' || actionPending) {
      return;
    }

    const round = state.round;

    setAction({ status: 'pending', kind: 'refresh' });

    try {
      const [ratedIds, watchedIds, cooldownIds] = await Promise.all([
        profile.getRatedIds(),
        profile.getWatchedIds(),
        profile.getActiveCooldownIds(),
      ]);
      const { request, droppedIds } = buildRefreshAllInput({
        ratedIds,
        watchedIds,
        tasteVector: round.intent.tasteVector,
        prompt: round.intent.prompt,
        visibleMovieIds: round.movies.map((pick) => pick.id),
        cooldownIds,
      });
      const response = await fetchRecommendations(request);

      await profile.setCooldowns(round.movies.map((pick) => pick.id));

      setExclusionTrimmed(droppedIds.length > 0);
      setState({
        status: 'results',
        round: { ...round, movies: response.movies },
      });
      setAction({ status: 'idle' });
    } catch (error) {
      setAction({ status: 'error', message: actionErrorMessage(error, REFRESH_ERROR_MESSAGE) });
    }
  }

  const controlsDisabled = pending || actionPending;
  const pendingReplaceIndex =
    action.status === 'pending' && action.kind === 'replace' ? action.index : null;

  return (
    <main className="page">
      <header className="masthead">
        <h1>Movie recommender</h1>
        <p className="tagline">One good pick, three alternatives, no endless scrolling.</p>
      </header>

      <form className="prompt-form" onSubmit={handleSubmit}>
        <label htmlFor="prompt">What are you in the mood for?</label>
        <div className="prompt-form__controls">
          <input
            id="prompt"
            type="text"
            maxLength={300}
            autoComplete="off"
            placeholder="A quiet thriller, something funny…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button type="submit" disabled={controlsDisabled}>
            {pending ? 'Finding a movie…' : 'Find my movie'}
          </button>
        </div>
      </form>

      <section className="results" aria-live="polite" aria-busy={controlsDisabled}>
        {pending && <p className="status">Finding something worth watching…</p>}

        {state.status === 'error' && <p className="status status--error">{state.message}</p>}

        {action.status === 'pending' && (
          <p className="status">
            {action.kind === 'refresh' ? 'Refreshing all picks…' : 'Finding another movie…'}
          </p>
        )}

        {state.status === 'results' &&
          (state.round.movies.length === 0 ? (
            <p className="status">No picks tonight. Try a different direction.</p>
          ) : (
            <div className="pick-round">
              <div className="pick-round__toolbar">
                <button
                  type="button"
                  className="pick-action"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void handleRefreshAll();
                  }}
                >
                  {action.status === 'pending' && action.kind === 'refresh'
                    ? 'Refreshing…'
                    : 'Refresh all'}
                </button>
                {action.status === 'error' && (
                  <p className="status status--error">{action.message}</p>
                )}
              </div>

              <div className="picks" key={state.round.requestId}>
                {state.round.movies[0] !== undefined && (
                  <MainPick
                    movie={state.round.movies[0]}
                    disabled={controlsDisabled}
                    pending={pendingReplaceIndex === 0}
                    onReject={() => {
                      void handleReplace(0);
                    }}
                  />
                )}
                <Alternatives
                  movies={state.round.movies.slice(1, 4)}
                  startIndex={1}
                  disabled={controlsDisabled}
                  pendingIndex={pendingReplaceIndex}
                  onReject={(index) => {
                    void handleReplace(index);
                  }}
                />
              </div>
            </div>
          ))}

        {state.status === 'results' && exclusionTrimmed && (
          <p className="status">{EXCLUSION_TRIM_NOTICE}</p>
        )}
      </section>

      <Library profile={profile} />
    </main>
  );
}
