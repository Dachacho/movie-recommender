import { useRef, useState, type FormEvent } from 'react';
import type { MovieCard, RecommendationResponse } from '@movie-recommender/shared';
import {
  RecommendationApiError,
  RecommendationNetworkError,
  fetchRecommendations,
  fetchTasteVector,
  type TasteVector,
} from './api';
import { createGuestProfile, type GuestProfile, type RatingsPayload } from './profile/GuestProfile';
import { buildRecommendationInput } from './recommendationInput';

type ScreenState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'results'; requestId: number; response: RecommendationResponse }
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

function MainPick({ movie }: { movie: MovieCard }) {
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
      </div>
    </article>
  );
}

function Alternatives({ movies }: { movies: MovieCard[] }) {
  if (movies.length === 0) {
    return null;
  }

  return (
    <section className="alternatives">
      <h2 className="alternatives__heading">Also worth a look</h2>
      <ul className="alternatives__list" aria-label="Alternatives">
        {movies.map((movie) => (
          <li key={movie.id} className="alternative">
            <MoviePoster movie={movie} />
            <h3 className="alternative__title">{movie.title}</h3>
            {movie.releaseYear !== null && <p className="alternative__year">{movie.releaseYear}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function App({ profile: providedProfile }: AppProps = {}) {
  const [profile] = useState<GuestProfile>(() => providedProfile ?? createGuestProfile());
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const requestId = useRef(0);
  const tasteCache = useRef<TasteCache | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (state.status === 'pending') {
      return;
    }

    requestId.current += 1;
    const currentRequestId = requestId.current;

    setState({ status: 'pending' });

    try {
      const profileVersion = profile.getVersion();
      const [ratings, watchedIds] = await Promise.all([
        profile.ratingsPayload(),
        profile.getWatchedIds(),
      ]);
      const tasteVector = await tasteVectorFor(
        ratings,
        profileVersion,
        tasteCache.current,
        (next) => {
          tasteCache.current = next;
        },
      );
      const request = buildRecommendationInput(ratings, watchedIds, tasteVector, prompt);
      const response = await fetchRecommendations(request);

      setState({ status: 'results', requestId: currentRequestId, response });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  }

  const pending = state.status === 'pending';

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
          <button type="submit" disabled={pending}>
            {pending ? 'Finding a movie…' : 'Find my movie'}
          </button>
        </div>
      </form>

      <section className="results" aria-live="polite" aria-busy={pending}>
        {pending && <p className="status">Finding something worth watching…</p>}

        {state.status === 'error' && <p className="status status--error">{state.message}</p>}

        {state.status === 'results' &&
          (state.response.movies.length === 0 ? (
            <p className="status">No picks tonight. Try a different direction.</p>
          ) : (
            <div className="picks" key={state.requestId}>
              {state.response.movies[0] !== undefined && (
                <MainPick movie={state.response.movies[0]} />
              )}
              <Alternatives movies={state.response.movies.slice(1, 4)} />
            </div>
          ))}
      </section>
    </main>
  );
}
