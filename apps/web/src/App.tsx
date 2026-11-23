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
  rewatchCandidateIds,
  type RecommendationSourceKind,
  type SourceSelection,
} from './recommendationInput';

/**
 * The intent a round was drawn with. The taste vector, prompt and source stay
 * pinned to the round; hard exclusions and the candidate pool are always
 * re-read from the profile so later library changes are respected.
 */
interface RoundIntent {
  tasteVector: TasteVector;
  prompt: string;
  source: RecommendationSourceKind;
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
  | { status: 'empty-pool'; message: string }
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
const POOL_TRIM_NOTICE =
  'Your shortlist is larger than a single request can rank — the highest-numbered entries beyond the first 10,000 were left out this round.';

const EMPTY_WATCHLIST_MESSAGE = 'Your watchlist is empty — add films in the library.';
const EMPTY_REWATCH_MESSAGE = 'Rate some films 4 stars or higher to build a rewatch shortlist.';

const SOURCE_OPTIONS: readonly { value: RecommendationSourceKind; label: string }[] = [
  { value: 'catalog', label: 'The whole catalog' },
  { value: 'watchlist', label: 'My watchlist' },
  { value: 'rewatch', label: 'Rewatch shortlist' },
];

interface SourceResolution {
  selection: SourceSelection;
  /** Set when a pool source has nothing to draw from. */
  emptyMessage: string | null;
}

/**
 * Reads the round's candidate pool at action time. Watchlist films keep the
 * usual rated/watched exclusions; rewatch candidates are rated films, so the
 * builder treats them differently. An empty pool must never reach the API:
 * `recommendationRequestSchema` rejects empty `candidateIds`.
 */
async function resolveSourceSelection(
  profile: GuestProfile,
  kind: RecommendationSourceKind,
): Promise<SourceResolution> {
  if (kind === 'catalog') {
    return { selection: { kind }, emptyMessage: null };
  }

  if (kind === 'watchlist') {
    const candidateIds = await profile.getWatchlistIds();

    return {
      selection: { kind, candidateIds },
      emptyMessage: candidateIds.length === 0 ? EMPTY_WATCHLIST_MESSAGE : null,
    };
  }

  const candidateIds = rewatchCandidateIds(await profile.getRatings());

  return {
    selection: { kind: 'rewatch', candidateIds },
    emptyMessage: candidateIds.length === 0 ? EMPTY_REWATCH_MESSAGE : null,
  };
}

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
  const [sourceKind, setSourceKind] = useState<RecommendationSourceKind>('catalog');
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const [action, setAction] = useState<ActionState>({ status: 'idle' });
  const [exclusionTrimmed, setExclusionTrimmed] = useState(false);
  const [poolTrimmed, setPoolTrimmed] = useState(false);
  const requestId = useRef(0);
  const tasteCache = useRef<TasteCache | null>(null);

  const actionPending = action.status === 'pending';
  const pending = state.status === 'pending';

  function handleSourceChange(next: RecommendationSourceKind): void {
    setSourceKind(next);
    // The empty-pool copy names one source; drop it when the source changes.
    setState((previous) => (previous.status === 'empty-pool' ? { status: 'idle' } : previous));
  }

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
      const source = await resolveSourceSelection(profile, sourceKind);

      // An empty pool has nothing to rank; skip the taste request too.
      if (source.emptyMessage !== null) {
        setState({ status: 'empty-pool', message: source.emptyMessage });
        return;
      }

      const tasteVector = await tasteVectorFor(
        ratings,
        profileVersion,
        tasteCache.current,
        (next) => {
          tasteCache.current = next;
        },
      );
      const trimmedPrompt = prompt.trim();
      const { request, droppedIds, poolDroppedIds } = buildRecommendationInput({
        ratedIds,
        watchedIds,
        tasteVector,
        prompt: trimmedPrompt,
        cooldownIds,
        source: source.selection,
      });
      const response = await fetchRecommendations(request);

      setExclusionTrimmed(droppedIds.length > 0);
      setPoolTrimmed(poolDroppedIds.length > 0);
      setState({
        status: 'results',
        round: {
          requestId: currentRequestId,
          movies: response.movies,
          intent: { tasteVector, prompt: trimmedPrompt, source: sourceKind },
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
      const source = await resolveSourceSelection(profile, round.intent.source);

      if (source.emptyMessage !== null) {
        setAction({ status: 'error', message: source.emptyMessage });
        return;
      }

      const { request, droppedIds, poolDroppedIds } = buildReplacementInput({
        ratedIds,
        watchedIds,
        tasteVector: round.intent.tasteVector,
        prompt: round.intent.prompt,
        visibleMovieIds: round.movies.map((pick) => pick.id),
        replacedMovieId: movie.id,
        cooldownIds,
        source: source.selection,
      });
      const response = await fetchRecommendations(request);

      await profile.setCooldown(movie.id);

      setExclusionTrimmed(droppedIds.length > 0);
      setPoolTrimmed(poolDroppedIds.length > 0);
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
      const source = await resolveSourceSelection(profile, round.intent.source);

      if (source.emptyMessage !== null) {
        setAction({ status: 'error', message: source.emptyMessage });
        return;
      }

      const { request, droppedIds, poolDroppedIds } = buildRefreshAllInput({
        ratedIds,
        watchedIds,
        tasteVector: round.intent.tasteVector,
        prompt: round.intent.prompt,
        visibleMovieIds: round.movies.map((pick) => pick.id),
        cooldownIds,
        source: source.selection,
      });
      const response = await fetchRecommendations(request);

      await profile.setCooldowns(round.movies.map((pick) => pick.id));

      setExclusionTrimmed(droppedIds.length > 0);
      setPoolTrimmed(poolDroppedIds.length > 0);
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
        <fieldset className="source-picker">
          <legend>Recommend from</legend>
          <div className="source-picker__options">
            {SOURCE_OPTIONS.map((option) => (
              <label className="source-picker__option" key={option.value}>
                <input
                  type="radio"
                  name="recommendation-source"
                  value={option.value}
                  checked={sourceKind === option.value}
                  onChange={() => handleSourceChange(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

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

        {state.status === 'empty-pool' && <p className="status">{state.message}</p>}

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

        {state.status === 'results' && poolTrimmed && <p className="status">{POOL_TRIM_NOTICE}</p>}
      </section>

      <Library profile={profile} />
    </main>
  );
}
