import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LetterboxdUnmatched, MovieCard } from '@movie-recommender/shared';
import {
  RecommendationApiError,
  RecommendationNetworkError,
  fetchRecommendations,
  fetchTasteVector,
  importLetterboxd,
  type TasteVector,
} from './api';
import { Dashboard } from './Dashboard';
import { Library } from './Library';
import { convertListPaste } from './listPaste';
import {
  createGuestProfile,
  type GuestProfile,
  type RatingsPayload,
  type RecordRoundInput,
} from './profile/GuestProfile';
import {
  EXPLORATION_STRENGTH,
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
 *
 * The exception is a pasted list: its matched ids are pinned too, because the
 * textarea is a one-shot import rather than a live profile collection. A
 * later paste cannot change a round that is already on screen. "Surprise me"
 * is a live session mode instead, read from the toggle for every request,
 * replacements and refreshes included.
 */
interface RoundIntent {
  tasteVector: TasteVector;
  prompt: string;
  source: RecommendationSourceKind;
  /** Matched paste ids, fixed for the round; null for sources read live. */
  candidateIds: readonly number[] | null;
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

type View = 'picks' | 'dashboard';

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
const EMPTY_PASTE_MESSAGE = 'No films from that list are in the catalog yet.';
const EMPTY_PASTE_INPUT_MESSAGE = 'Paste a list first — one film per line.';
const PASTE_IMPORT_ERROR_MESSAGE = 'Could not match that list. Try again.';

const SOURCE_OPTIONS: readonly {
  value: RecommendationSourceKind;
  label: string;
  hint: string;
}[] = [
  { value: 'catalog', label: 'The whole catalog', hint: 'Everything in the catalog' },
  { value: 'watchlist', label: 'My watchlist', hint: 'Films you saved' },
  { value: 'rewatch', label: 'Rewatch shortlist', hint: 'Rated 4 stars or higher' },
  { value: 'paste', label: "A list I'll paste", hint: 'Titles or Letterboxd CSV' },
];

interface PasteReport {
  matched: number;
  unmatched: readonly LetterboxdUnmatched[];
  /** Pasted lines the converter could not turn into a film row. */
  unparseable: readonly string[];
}

type PastePreparation =
  { status: 'ready'; candidateIds: number[] } | { status: 'invalid'; message: string };

interface SourceResolution {
  selection: SourceSelection;
  /** Set when a pool source has nothing to draw from. */
  emptyMessage: string | null;
}

/**
 * Reads the round's candidate pool at action time. Watchlist films keep the
 * usual rated/watched exclusions; rewatch candidates are rated films, so the
 * builder treats them differently. A paste pool is already matched and fixed
 * for its round, so `fixedCandidateIds` is returned as-is. An empty pool must
 * never reach the API: `recommendationRequestSchema` rejects empty
 * `candidateIds`.
 */
async function resolveSourceSelection(
  profile: GuestProfile,
  kind: RecommendationSourceKind,
  fixedCandidateIds: readonly number[] | null = null,
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

  if (kind === 'paste') {
    const candidateIds = fixedCandidateIds ?? [];

    return {
      selection: { kind, candidateIds },
      emptyMessage: candidateIds.length === 0 ? EMPTY_PASTE_MESSAGE : null,
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

/**
 * History is secondary to the round itself: a write failure must not turn
 * shown picks into an error, and guest data is never logged.
 */
async function rememberRound(profile: GuestProfile, input: RecordRoundInput): Promise<void> {
  if (input.movies.length === 0) {
    return;
  }

  try {
    await profile.recordRound(input);
  } catch {
    // Best effort only; the picks are already on screen.
  }
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

function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById('main-content')?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}

function Masthead({ view }: { view: View }) {
  return (
    <header className="masthead">
      <div className="masthead__inner">
        <a className="brand" href="#picks">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" stroke="currentColor" />
              <path d="M7 4.5v15M17 4.5v15" stroke="currentColor" />
              <circle cx="12" cy="12" r="3" stroke="currentColor" />
            </svg>
          </span>
          <h1>Movie recommender</h1>
        </a>

        <nav className="view-nav" aria-label="Views">
          <a href="#picks" aria-current={view === 'picks' ? 'page' : undefined}>
            Picks
          </a>
          <a href="#dashboard" aria-current={view === 'dashboard' ? 'page' : undefined}>
            Dashboard
          </a>
        </nav>

        <p className="masthead__status">
          <span className="masthead__dot" aria-hidden="true" />
          Local profile
        </p>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-line">
      <h2 className="hero__line" id="hero-line">
        One film for tonight.
      </h2>
      <p className="hero__lede">
        Tell us the mood, or leave it blank. We'll choose one film and three backups from what
        you've rated and what you feel like watching.
      </p>
      <ul className="hero__notes">
        <li>No account needed</li>
        <li>Your library stays local</li>
        <li>Letterboxd-ready</li>
      </ul>
      <dl className="hero__principles">
        <div>
          <dt>Source</dt>
          <dd>The whole catalog, your watchlist, or a list you bring.</dd>
        </div>
        <div>
          <dt>Taste</dt>
          <dd>Your ratings, kept in this browser and never on a server.</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>One film and three backups. Rejects rest for seven days.</dd>
        </div>
      </dl>
    </section>
  );
}

function MoviePoster({ movie, priority }: { movie: MovieCard; priority?: boolean }) {
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
      width={500}
      height={750}
      loading={priority === true ? 'eager' : 'lazy'}
      fetchPriority={priority === true ? 'high' : 'auto'}
      decoding="async"
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
      <div className="main-pick__frame">
        <MoviePoster movie={movie} priority />
      </div>
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
      <div className="alternatives__head">
        <h2 className="alternatives__heading">If that's not it</h2>
        <p className="alternatives__hint">Three more, chosen to sit apart from the main pick.</p>
      </div>
      <ul className="alternatives__list" aria-label="Alternatives">
        {movies.map((movie, offset) => {
          const index = startIndex + offset;

          return (
            <li key={movie.id} className="alternative">
              <div className="alternative__frame">
                <MoviePoster movie={movie} />
              </div>
              <div className="alternative__body">
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
  const [view, setView] = useState<View>(() =>
    window.location.hash === '#dashboard' ? 'dashboard' : 'picks',
  );
  const [prompt, setPrompt] = useState('');
  const [sourceKind, setSourceKind] = useState<RecommendationSourceKind>('catalog');
  const [surpriseMe, setSurpriseMe] = useState(false);
  const [pastedList, setPastedList] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteReport, setPasteReport] = useState<PasteReport | null>(null);
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const [action, setAction] = useState<ActionState>({ status: 'idle' });
  const [exclusionTrimmed, setExclusionTrimmed] = useState(false);
  const [poolTrimmed, setPoolTrimmed] = useState(false);
  const requestId = useRef(0);
  const tasteCache = useRef<TasteCache | null>(null);

  const actionPending = action.status === 'pending';
  const pending = state.status === 'pending';

  useEffect(() => {
    function handleHashChange() {
      setView(window.location.hash === '#dashboard' ? 'dashboard' : 'picks');
    }

    window.addEventListener('hashchange', handleHashChange);

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  function handleSourceChange(next: RecommendationSourceKind): void {
    setSourceKind(next);
    setPasteError(null);
    // The empty-pool copy names one source; drop it when the source changes.
    setState((previous) => (previous.status === 'empty-pool' ? { status: 'idle' } : previous));
  }

  /**
   * Converts the pasted text and imports it for matching. The conversion is a
   * pure client-side step; the import endpoint is the already-approved
   * Letterboxd matcher. Ratings in a pasted Letterboxd CSV are ignored for
   * this source: the list selects a pool, it does not rate or watch anything.
   */
  async function preparePaste(): Promise<PastePreparation> {
    setPasteError(null);
    setPasteReport(null);

    if (pastedList.trim() === '') {
      return { status: 'invalid', message: EMPTY_PASTE_INPUT_MESSAGE };
    }

    const conversion = convertListPaste(pastedList);

    if (!conversion.ok) {
      return { status: 'invalid', message: conversion.message };
    }

    try {
      const report = await importLetterboxd(conversion.csv);

      setPasteReport({
        matched: report.matched.length,
        unmatched: report.unmatched,
        unparseable: conversion.unparseable,
      });

      return { status: 'ready', candidateIds: report.matched.map((match) => match.movieId) };
    } catch (error) {
      return {
        status: 'invalid',
        message: actionErrorMessage(error, PASTE_IMPORT_ERROR_MESSAGE),
      };
    }
  }

  async function submitRound() {
    if (pending || actionPending) {
      return;
    }

    requestId.current += 1;
    const currentRequestId = requestId.current;
    const previousState = state;

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

      let source: SourceResolution;

      if (sourceKind === 'paste') {
        const prepared = await preparePaste();

        if (prepared.status === 'invalid') {
          setPasteError(prepared.message);
          setState(previousState);
          return;
        }

        source = {
          selection: { kind: 'paste', candidateIds: prepared.candidateIds },
          emptyMessage: prepared.candidateIds.length === 0 ? EMPTY_PASTE_MESSAGE : null,
        };
      } else {
        source = await resolveSourceSelection(profile, sourceKind);
      }

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
        ...(surpriseMe ? { exploration: EXPLORATION_STRENGTH } : {}),
      });
      const response = await fetchRecommendations(request);

      setExclusionTrimmed(droppedIds.length > 0);
      setPoolTrimmed(poolDroppedIds.length > 0);
      setState({
        status: 'results',
        round: {
          requestId: currentRequestId,
          movies: response.movies,
          intent: {
            tasteVector,
            prompt: trimmedPrompt,
            source: sourceKind,
            candidateIds: source.selection.kind === 'paste' ? source.selection.candidateIds : null,
          },
        },
      });
      await rememberRound(profile, {
        kind: 'round',
        source: sourceKind,
        prompt: trimmedPrompt,
        replacedMovieId: null,
        movies: response.movies,
      });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitRound();
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
      const source = await resolveSourceSelection(
        profile,
        round.intent.source,
        round.intent.candidateIds,
      );

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
        ...(surpriseMe ? { exploration: EXPLORATION_STRENGTH } : {}),
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
      await rememberRound(profile, {
        kind: 'replace',
        source: round.intent.source,
        prompt: round.intent.prompt,
        replacedMovieId: movie.id,
        movies: mergeReplacement(round.movies, index, response.movies),
      });
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
      const source = await resolveSourceSelection(
        profile,
        round.intent.source,
        round.intent.candidateIds,
      );

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
        ...(surpriseMe ? { exploration: EXPLORATION_STRENGTH } : {}),
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
      await rememberRound(profile, {
        kind: 'refresh',
        source: round.intent.source,
        prompt: round.intent.prompt,
        replacedMovieId: null,
        movies: response.movies,
      });
    } catch (error) {
      setAction({ status: 'error', message: actionErrorMessage(error, REFRESH_ERROR_MESSAGE) });
    }
  }

  const controlsDisabled = pending || actionPending;
  const pendingReplaceIndex =
    action.status === 'pending' && action.kind === 'replace' ? action.index : null;

  const hasResults = state.status === 'results';
  const roundSourceLabel =
    state.status === 'results'
      ? {
          catalog: 'the whole catalog',
          watchlist: 'your watchlist',
          rewatch: 'your rewatch shortlist',
          paste: 'your pasted list',
        }[state.round.intent.source]
      : 'the whole catalog';

  if (view === 'dashboard') {
    return (
      <div className="shell">
        <SkipLink />
        <Masthead view={view} />
        <main id="main-content" tabIndex={-1} className="page page--dashboard">
          <Dashboard profile={profile} />
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <SkipLink />
      <Masthead view={view} />

      <main id="main-content" tabIndex={-1} className={`page${hasResults ? ' page--results' : ''}`}>
        {!hasResults && <Hero />}

        <form
          className={`prompt-form${hasResults ? ' prompt-form--compact' : ''}`}
          onSubmit={handleSubmit}
        >
          <div className="prompt-form__head">
            <h2 className="prompt-form__title">Set the brief</h2>
            <p className="prompt-form__hint">A source, a mood, and that's it.</p>
          </div>

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
                  <span className="source-picker__copy">
                    <span className="source-picker__label">{option.label}</span>
                    <span className="source-picker__hint" aria-hidden="true">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="switch-row">
            <input
              type="checkbox"
              name="surprise-me"
              checked={surpriseMe}
              disabled={controlsDisabled}
              onChange={(event) => setSurpriseMe(event.target.checked)}
            />
            <span className="switch-row__control" aria-hidden="true">
              <span className="switch-row__knob" />
            </span>
            <span className="switch-row__copy">
              <span className="switch-row__label">Surprise me</span>
              <span className="switch-row__hint" aria-hidden="true">
                Reach past your usual taste
              </span>
            </span>
          </label>

          {sourceKind === 'paste' && (
            <section className="list-paste" aria-label="Pasted list">
              <label htmlFor="list-paste">Paste a list — one film per line</label>
              <textarea
                id="list-paste"
                name="pasted-list"
                rows={6}
                value={pastedList}
                placeholder={'Heat (1995)\nIn the Mood for Love\nAlien, 1979'}
                onChange={(event) => setPastedList(event.target.value)}
              />
              <div className="list-paste__actions">
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void submitRound();
                  }}
                >
                  Use this list
                </button>
                <p className="list-paste__hint">
                  One film per line, or paste Letterboxd CSV rows. Ratings are ignored for this
                  source.
                </p>
              </div>

              {pasteError !== null && <p className="status status--error">{pasteError}</p>}

              {pasteReport !== null && (
                <div className="import__report">
                  {pasteReport.matched > 0 && (
                    <p className="status import__status">
                      {`Matched ${String(pasteReport.matched)} of ${String(
                        pasteReport.matched + pasteReport.unmatched.length,
                      )} ${
                        pasteReport.matched + pasteReport.unmatched.length === 1 ? 'film' : 'films'
                      } from your list.`}
                    </p>
                  )}

                  {pasteReport.unmatched.length > 0 && (
                    <details className="import__unmatched">
                      <summary>
                        Not in the catalog:{' '}
                        {pasteReport.unmatched.length === 1
                          ? '1 film'
                          : `${String(pasteReport.unmatched.length)} films`}
                      </summary>
                      <ul className="import__list">
                        {pasteReport.unmatched.map((unmatched) => (
                          <li key={`${unmatched.name}\u0000${String(unmatched.year ?? '')}`}>
                            {unmatched.year === null
                              ? unmatched.name
                              : `${unmatched.name} (${String(unmatched.year)})`}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {pasteReport.unparseable.length > 0 && (
                    <details className="import__unmatched">
                      <summary>
                        Could not read:{' '}
                        {pasteReport.unparseable.length === 1
                          ? '1 line'
                          : `${String(pasteReport.unparseable.length)} lines`}
                      </summary>
                      <ul className="import__list">
                        {pasteReport.unparseable.map((line, index) => (
                          <li key={`${String(index)}:${line}`}>{line}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </section>
          )}

          <div className="prompt-form__field">
            <div className="prompt-form__field-head">
              <label htmlFor="prompt">What are you in the mood for?</label>
              <span className="prompt-form__optional" aria-hidden="true">
                Optional
              </span>
            </div>
            <div className="prompt-form__controls">
              <input
                id="prompt"
                name="mood"
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
          </div>

          <p className="prompt-form__note">Your ratings and history stay in this browser.</p>
        </form>

        <section className="results" aria-live="polite" aria-busy={controlsDisabled}>
          {pending && <p className="status status--pending">Finding something worth watching…</p>}

          {state.status === 'error' && <p className="status status--error">{state.message}</p>}

          {state.status === 'empty-pool' && <p className="status">{state.message}</p>}

          {action.status === 'pending' && (
            <p className="status status--pending">
              {action.kind === 'refresh' ? 'Refreshing all picks…' : 'Finding another movie…'}
            </p>
          )}

          {state.status === 'results' &&
            (state.round.movies.length === 0 ? (
              <p className="status">No picks tonight. Try a different direction.</p>
            ) : (
              <div className="pick-round">
                <div className="pick-round__toolbar">
                  <div className="pick-round__heading">
                    <h2 className="pick-round__title">Tonight's picks</h2>
                    <p className="pick-round__meta">
                      {`${String(state.round.movies.length)} ${
                        state.round.movies.length === 1 ? 'film' : 'films'
                      } from ${roundSourceLabel}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="pick-action pick-action--quiet"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void handleRefreshAll();
                    }}
                  >
                    {action.status === 'pending' && action.kind === 'refresh'
                      ? 'Refreshing…'
                      : 'Refresh all'}
                  </button>
                </div>

                {action.status === 'error' && (
                  <p className="status status--error">{action.message}</p>
                )}

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

          {state.status === 'results' && poolTrimmed && (
            <p className="status">{POOL_TRIM_NOTICE}</p>
          )}
        </section>

        <Library profile={profile} />
      </main>
    </div>
  );
}
