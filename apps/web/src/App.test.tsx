import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { App } from './App';
import { LIST_PASTE_TOO_LONG_MESSAGE } from './listPaste';
import { GuestProfile } from './profile/GuestProfile';
import { MemoryGuestProfileStorage } from './profile/memoryStorage';
import type { HistoryEntry } from './profile/schema';
import { MAX_CANDIDATE_IDS, MAX_EXCLUDE_IDS } from './recommendationInput';

const TRIM_NOTICE =
  'Your library is larger than a single request can exclude — the oldest entries may occasionally reappear.';
const POOL_TRIM_NOTICE =
  'Your shortlist is larger than a single request can rank — the highest-numbered entries beyond the first 10,000 were left out this round.';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const ARRIVAL: MovieCard = {
  id: 1,
  title: 'Arrival',
  releaseYear: 2016,
  runtime: 116,
  overview:
    'A linguist is recruited by the military to communicate with alien lifeforms after twelve mysterious spacecraft appear around the world.',
  genres: ['Science Fiction', 'Drama'],
  director: 'Denis Villeneuve',
  cast: ['Amy Adams', 'Jeremy Renner'],
  posterPath: '/arrival.jpg',
  voteAverage: 7.6,
};

const MOONLIGHT: MovieCard = {
  id: 2,
  title: 'Moonlight',
  releaseYear: 2016,
  runtime: 111,
  overview: 'A young man grapples with his identity and sexuality while growing up in Miami.',
  genres: ['Drama'],
  director: 'Barry Jenkins',
  cast: ['Trevante Rhodes'],
  posterPath: '/moonlight.jpg',
  voteAverage: 7.4,
};

const HEAT: MovieCard = {
  id: 3,
  title: 'Heat',
  releaseYear: 1995,
  runtime: 170,
  overview: 'A dedicated detective pursues a crew of professional thieves in Los Angeles.',
  genres: ['Crime', 'Drama'],
  director: 'Michael Mann',
  cast: ['Al Pacino', 'Robert De Niro'],
  posterPath: '/heat.jpg',
  voteAverage: 7.8,
};

const PADDINGTON_2: MovieCard = {
  id: 4,
  title: 'Paddington 2',
  releaseYear: 2017,
  runtime: 103,
  overview: 'Paddington looks for the perfect gift for his aunt, only to be framed for theft.',
  genres: ['Family', 'Comedy'],
  director: 'Paul King',
  cast: ['Ben Whishaw'],
  posterPath: null,
  voteAverage: 7.6,
};

const BROKEN_POSTER: MovieCard = {
  id: 5,
  title: 'Broken Poster',
  releaseYear: 2020,
  runtime: 100,
  overview: 'A fixture whose poster image fails to load.',
  genres: ['Drama'],
  director: 'Test Director',
  cast: [],
  posterPath: '/broken-poster.jpg',
  voteAverage: 6.5,
};

const SICARIO: MovieCard = {
  id: 6,
  title: 'Sicario',
  releaseYear: 2015,
  runtime: 121,
  overview: 'An idealistic FBI agent is enlisted by a government task force.',
  genres: ['Thriller', 'Drama'],
  director: 'Denis Villeneuve',
  cast: ['Emily Blunt'],
  posterPath: '/sicario.jpg',
  voteAverage: 7.3,
};

const THE_LIGHTHOUSE: MovieCard = {
  id: 7,
  title: 'The Lighthouse',
  releaseYear: 2019,
  runtime: 109,
  overview: 'Two lighthouse keepers try to maintain their sanity.',
  genres: ['Drama', 'Horror'],
  director: 'Robert Eggers',
  cast: ['Robert Pattinson'],
  posterPath: '/lighthouse.jpg',
  voteAverage: 7.2,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function stubFetch(): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function getPromptInput(): HTMLInputElement {
  return screen.getByLabelText('What are you in the mood for?') as HTMLInputElement;
}

function getForm(): HTMLFormElement {
  const form = getPromptInput().closest('form');

  if (form === null) {
    throw new Error('Prompt input is not inside the form');
  }

  return form;
}

function submittedBody(fetchMock: Mock<typeof fetch>, callIndex = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];

  if (call === undefined) {
    throw new Error('fetch was not called');
  }

  const init = call[1];

  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('fetch call has no JSON body');
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

const TASTE_VECTOR = Array.from({ length: 384 }, (_value, index) => (index === 0 ? 1 : 0));

function createProfile(): GuestProfile {
  return new GuestProfile(new MemoryGuestProfileStorage());
}

function getPasteInput(): HTMLTextAreaElement {
  return screen.getByLabelText('Paste a list — one film per line') as HTMLTextAreaElement;
}

function importResponse(
  matchedIds: readonly number[],
  unmatched: readonly { name: string; year: number | null }[] = [],
): Response {
  return jsonResponse({
    matched: matchedIds.map((movieId) => ({
      movieId,
      title: `Movie ${String(movieId)}`,
      releaseYear: null,
      rating: null,
    })),
    unmatched: unmatched.map((film) => ({ ...film, reason: 'no_match' })),
    stats: {
      rows: matchedIds.length + unmatched.length,
      matched: matchedIds.length,
      unmatched: unmatched.length,
      invalid: 0,
    },
  });
}

function renderApp(profile: GuestProfile = createProfile()): ReturnType<typeof render> {
  return render(<App profile={profile} />);
}

function navigateTo(path: 'picks' | 'library' | 'library/find' | 'dashboard'): void {
  window.history.replaceState(null, '', `#${path}`);
  fireEvent(window, new Event('hashchange'));
}

function renderLibraryApp(profile: GuestProfile = createProfile()): ReturnType<typeof render> {
  window.history.replaceState(null, '', '#library/find');

  return render(<App profile={profile} />);
}

function recommendationResponse(): Response {
  return jsonResponse({ movies: [ARRIVAL], coldStart: false });
}

function stubTasteAndRecommendations(tasteVector: unknown): Mock<typeof fetch> {
  const fetchMock = stubFetch();

  fetchMock.mockImplementation(async (input) => {
    if (input === '/api/taste') {
      return jsonResponse({ tasteVector });
    }

    return recommendationResponse();
  });

  return fetchMock;
}

async function submitPrompt(prompt: string): Promise<void> {
  fireEvent.change(getPromptInput(), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));
}

function selectSource(label: string): void {
  fireEvent.click(screen.getByRole('radio', { name: label }));
}

function movieSnapshot(movie: MovieCard): HistoryEntry['movies'][number] {
  return {
    id: movie.id,
    title: movie.title,
    releaseYear: movie.releaseYear,
    posterPath: movie.posterPath,
  };
}

async function waitForHistory(profile: GuestProfile, count: number): Promise<HistoryEntry[]> {
  return waitFor(async () => {
    const history = await profile.getHistory();

    expect(history).toHaveLength(count);

    return history;
  });
}

describe('App', () => {
  it('shows the heading, prompt label and button before any request', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Movie recommender' })).toBeTruthy();
    expect(getPromptInput().value).toBe('');
    expect(screen.getByRole('button', { name: 'Find my movie' })).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: 'The whole catalog' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByRole('radio', { name: 'My watchlist' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Rewatch shortlist' })).toBeTruthy();
  });

  it('posts a trimmed prompt when the input is not empty', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL], coldStart: false }));

    renderApp();
    await submitPrompt('  a quiet science fiction film  ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/recommendations');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(submittedBody(fetchMock)).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'a quiet science fiction film',
    });
  });

  it('omits the prompt when the input is empty', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL], coldStart: true }));

    renderApp();
    await submitPrompt('   ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(submittedBody(fetchMock)).toEqual({ source: 'catalog', limit: 4 });
  });

  it('does not send another request while one is pending', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    renderApp();
    const form = getForm();
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const pendingButton = screen.getByRole('button', { name: 'Finding a movie…' });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the main pick with its details and the alternatives row', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({
        movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2],
        coldStart: false,
      }),
    );

    renderApp();
    await submitPrompt('something thoughtful');

    const mainPick = await screen.findByRole('article', { name: 'Main pick' });
    expect(within(mainPick).getByRole('heading', { name: 'Arrival' })).toBeTruthy();
    expect(within(mainPick).getByText(/2016/)).toBeTruthy();
    expect(within(mainPick).getByText(/Directed by Denis Villeneuve/)).toBeTruthy();
    expect(within(mainPick).getByText(/116 min/)).toBeTruthy();
    expect(within(mainPick).getByText(/A linguist is recruited/)).toBeTruthy();
    expect(within(mainPick).getByText('Science Fiction, Drama')).toBeTruthy();

    const poster = within(mainPick).getByAltText('Poster for Arrival');
    expect(poster.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w500/arrival.jpg');
    expect(poster.getAttribute('loading')).toBe('eager');

    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(3);
    expect(within(alternatives).getByAltText('Poster for Moonlight').getAttribute('loading')).toBe(
      'lazy',
    );
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    expect(within(alternatives).getByText('Heat')).toBeTruthy();
    expect(within(alternatives).getByText('Paddington 2')).toBeTruthy();
    expect(within(alternatives).queryByText('Arrival')).toBeNull();
  });

  it('renders only the movies that came back', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }));

    renderApp();
    await submitPrompt('');

    await screen.findByRole('heading', { name: 'Arrival' });

    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(1);
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    expect(screen.queryByText('Heat')).toBeNull();
  });

  it('renders a placeholder when a movie has no poster', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [PADDINGTON_2], coldStart: false }));

    renderApp();
    await submitPrompt('');

    expect(
      await screen.findByRole('img', { name: 'No poster available for Paddington 2' }),
    ).toBeTruthy();
  });

  it('falls back to the placeholder when a poster image fails to load', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [BROKEN_POSTER], coldStart: false }));

    renderApp();
    await submitPrompt('');

    fireEvent.error(await screen.findByAltText('Poster for Broken Poster'));

    const placeholder = await screen.findByRole('img', {
      name: 'No poster available for Broken Poster',
    });
    expect(placeholder.classList.contains('poster--placeholder')).toBe(true);
    expect(screen.queryByAltText('Poster for Broken Poster')).toBeNull();
  });

  it('renders the empty state when no movies are returned', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [], coldStart: true }));

    renderApp();
    await submitPrompt('something impossible');

    expect(await screen.findByText('No picks tonight. Try a different direction.')).toBeTruthy();
  });

  it('shows the API error message and keeps the button usable', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many recommendation requests. Try again later.',
          },
        },
        429,
      ),
    );

    renderApp();
    await submitPrompt('');

    const message = await screen.findByText('Too many recommendation requests. Try again later.');
    expect(message).toBeTruthy();

    const button = screen.getByRole('button', { name: 'Find my movie' });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('shows a network message when the request cannot be made', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderApp();
    await submitPrompt('');

    expect(
      await screen.findByText(
        'Could not reach the recommendation service. Check your connection and try again.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find my movie' })).toBeTruthy();
  });

  it('requests a taste vector and excludes rated and watched movies from recommendations', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.setRating(1, 4.5);
    await profile.setWatched(3);

    renderApp(profile);
    await submitPrompt('  quiet science fiction  ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/taste');
    expect(submittedBody(fetchMock, 0)).toEqual({ ratings: [{ movieId: 1, rating: 4.5 }] });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'quiet science fiction',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 3],
    });
  });

  it('excludes a rated movie from recommendations when nothing is marked watched', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.setRating(2, 4);

    renderApp(profile);
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 1)).toMatchObject({ excludeIds: [2] });
  });

  it('calls only recommendations when the guest has no ratings', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);

    renderApp();
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock)).toEqual({ source: 'catalog', limit: 4 });
  });

  it('shows the watchlist empty state and sends no request when the watchlist is empty', async () => {
    const fetchMock = stubFetch();

    renderApp();
    selectSource('My watchlist');
    await submitPrompt('');

    expect(
      await screen.findByText('Your watchlist is empty — add films in the library.'),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    selectSource('The whole catalog');
    expect(screen.queryByText('Your watchlist is empty — add films in the library.')).toBeNull();
  });

  it('shows the rewatch empty state and sends no request without a four-star film', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(1, 3.5);

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');

    expect(
      await screen.findByText('Rate some films 4 stars or higher to build a rewatch shortlist.'),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests recommendations from the watchlist with the usual exclusions', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.addToWatchlist(3);
    await profile.setRating(1, 4.5);
    await profile.setWatched(2);

    renderApp(profile);
    selectSource('My watchlist');
    await submitPrompt('  comfort  ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'watchlist',
      limit: 4,
      candidateIds: [3],
      prompt: 'comfort',
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 2],
    });
  });

  it('requests the rewatch shortlist from the list source without excluding rated films', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.setRating(1, 4.5);
    await profile.setRating(2, 3.5);

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [1],
      tasteVector: TASTE_VECTOR,
    });

    await screen.findByRole('heading', { name: 'Arrival' });
    expect(screen.queryByText(POOL_TRIM_NOTICE)).toBeNull();
  });

  it('replaces a rewatch pick from the same shortlist source', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(1, 4.5);
    await profile.setRating(3, 4);
    await profile.setRating(6, 4.5);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, HEAT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'Sicario' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submittedBody(fetchMock, 2)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [1, 3, 6],
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 3],
    });
  });

  it('shows a quiet notice when the rewatch pool is trimmed and still renders picks', async () => {
    const storage = new MemoryGuestProfileStorage();
    const profile = new GuestProfile(storage);
    const fetchMock = stubFetch();

    storage.seedRatings(
      Array.from({ length: 10_005 }, (_value, index) => ({
        movieId: index + 1,
        rating: 4,
        updatedAt: index,
      })),
    );

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL], coldStart: false }));

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');

    expect(await screen.findByRole('heading', { name: 'Arrival' })).toBeTruthy();
    expect(screen.getByText(POOL_TRIM_NOTICE)).toBeTruthy();
    expect(submittedBody(fetchMock, 1).candidateIds).toHaveLength(MAX_CANDIDATE_IDS);
    expect(submittedBody(fetchMock, 1).excludeIds).toBeUndefined();
  });

  it('refreshes a rewatch round from the shortlist without rated or watched exclusions', async () => {
    const now = 1_700_000_000_000;
    const storage = new MemoryGuestProfileStorage();
    storage.seedCooldowns([{ movieId: 9, expiresAt: now + 1 }]);
    const profile = new GuestProfile(storage, { now: () => now });
    const fetchMock = stubFetch();

    await profile.setRating(1, 4.5);
    await profile.setRating(3, 4);
    await profile.setRating(6, 4.5);
    await profile.setWatched(2);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, HEAT, SICARIO], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [THE_LIGHTHOUSE], coldStart: false }));

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');
    await screen.findByRole('button', { name: 'Refresh all' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(await screen.findByRole('heading', { name: 'The Lighthouse' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submittedBody(fetchMock, 2)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [1, 3, 6],
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 3, 6, 9],
    });
  });

  it('keeps rewatch picks and sends nothing when the pool empties before a replacement', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(1, 4.5);
    await profile.setRating(3, 4);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, HEAT], coldStart: false }));

    renderApp(profile);
    selectSource('Rewatch shortlist');
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    await profile.removeRating(1);
    await profile.removeRating(3);
    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    expect(
      await screen.findByText('Rate some films 4 stars or higher to build a rewatch shortlist.'),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Arrival' })).toBeTruthy();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);
  });

  it('refreshes a watchlist round from the watchlist source', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.addToWatchlist(3);
    await profile.setRating(1, 4.5);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [HEAT], coldStart: false }));

    renderApp(profile);
    selectSource('My watchlist');
    await submitPrompt('');
    await screen.findByRole('button', { name: 'Refresh all' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submittedBody(fetchMock, 2)).toEqual({
      source: 'watchlist',
      limit: 4,
      candidateIds: [3],
      tasteVector: TASTE_VECTOR,
      excludeIds: [1, 2],
    });
  });

  it('continues without a taste vector when the taste response is null', async () => {
    const fetchMock = stubTasteAndRecommendations(null);
    const profile = createProfile();

    await profile.setRating(1, 2);

    renderApp(profile);
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/taste');
    expect(submittedBody(fetchMock, 1)).toEqual({ source: 'catalog', limit: 4, excludeIds: [1] });
  });

  it('caches the taste vector until the profile version changes', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.setRating(1, 4);

    renderApp(profile);
    await submitPrompt('');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Find my movie' });

    fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByRole('button', { name: 'Find my movie' });

    await profile.setRating(2, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const tasteCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/taste');
    expect(tasteCalls).toHaveLength(2);
    expect(submittedBody(fetchMock, 4)).toMatchObject({
      tasteVector: TASTE_VECTOR,
    });
  });

  it('drops the cached taste vector once ratings are removed', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);
    const profile = createProfile();

    await profile.setRating(1, 4);

    renderApp(profile);
    await submitPrompt('');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Find my movie' });

    await profile.removeRating(1);
    fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const tasteCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/taste');
    expect(tasteCalls).toHaveLength(1);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 2)).toEqual({ source: 'catalog', limit: 4 });
  });

  it('searches only after the library search is submitted', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));

    renderLibraryApp();
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });

    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/movies/search?q=heat');
  });

  it('does not send a library search shorter than two characters', async () => {
    const fetchMock = stubFetch();

    renderLibraryApp();
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(
      await screen.findByText('Enter a search term between 2 and 80 characters.'),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the search error and leaves the search usable', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'invalid_request', message: 'Search is unavailable.' } }, 400),
    );

    renderLibraryApp();
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Search is unavailable.')).toBeTruthy();

    const searchButton = screen.getByRole('button', { name: 'Search' });
    expect((searchButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('reflects stored library state in matching search results', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(3, 4.5);
    await profile.setWatched(3);
    await profile.addToWatchlist(3);
    fetchMock.mockImplementation(async (input) =>
      typeof input === 'string' && input.startsWith('/api/movies/search')
        ? jsonResponse({ movies: [HEAT] })
        : recommendationResponse(),
    );

    renderLibraryApp(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const ratingGroup = await screen.findByRole('radiogroup', { name: 'Rating for Heat' });
    expect(screen.getByText('1995')).toBeTruthy();
    const fourAndAHalfStars = within(ratingGroup).getByRole('radio', {
      name: '4.5 stars out of 5',
    });
    await waitFor(() => expect((fourAndAHalfStars as HTMLInputElement).checked).toBe(true));

    expect(screen.getByRole('button', { name: 'Heat: watched' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Heat: watchlist' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('writes watched and watchlist toggles through the profile', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockImplementation(async (input) =>
      typeof input === 'string' && input.startsWith('/api/movies/search')
        ? jsonResponse({ movies: [HEAT] })
        : recommendationResponse(),
    );

    renderLibraryApp(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const watchedButton = await screen.findByRole('button', { name: 'Heat: watched' });
    expect(watchedButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(watchedButton);
    await waitFor(() => expect(watchedButton.getAttribute('aria-pressed')).toBe('true'));
    await expect(profile.getWatchedIds()).resolves.toEqual([3]);

    fireEvent.click(watchedButton);
    await waitFor(() => expect(watchedButton.getAttribute('aria-pressed')).toBe('false'));
    await expect(profile.getWatchedIds()).resolves.toEqual([]);

    const watchlistButton = screen.getByRole('button', { name: 'Heat: watchlist' });
    expect(watchlistButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(watchlistButton);
    await waitFor(() => expect(watchlistButton.getAttribute('aria-pressed')).toBe('true'));
    await expect(profile.getWatchlistIds()).resolves.toEqual([3]);

    fireEvent.click(watchlistButton);
    await waitFor(() => expect(watchlistButton.getAttribute('aria-pressed')).toBe('false'));
    await expect(profile.getWatchlistIds()).resolves.toEqual([]);
  });

  it('invalidates the cached taste vector when a rating is written through the library', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(1, 4);
    fetchMock.mockImplementation(async (input) => {
      if (input === '/api/taste') {
        return jsonResponse({ tasteVector: TASTE_VECTOR });
      }

      if (typeof input === 'string' && input.startsWith('/api/movies/search')) {
        return jsonResponse({ movies: [HEAT] });
      }

      return recommendationResponse();
    });

    renderApp(profile);
    await submitPrompt('');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Find my movie' });

    navigateTo('library/find');
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const ratingGroup = await screen.findByRole('radiogroup', { name: 'Rating for Heat' });
    const threeStars = within(ratingGroup).getByRole('radio', { name: '3 stars out of 5' });
    fireEvent.click(threeStars);
    await waitFor(() => expect((threeStars as HTMLInputElement).checked).toBe(true));

    navigateTo('picks');
    fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const tasteCalls = fetchMock.mock.calls.filter(([input]) => input === '/api/taste');
    expect(tasteCalls).toHaveLength(2);
    expect(submittedBody(fetchMock, 3)).toEqual({
      ratings: [
        { movieId: 1, rating: 4 },
        { movieId: 3, rating: 3 },
      ],
    });
    expect(submittedBody(fetchMock, 4)).toMatchObject({ tasteVector: TASTE_VECTOR });
  });

  it('shows the library load error and keeps search usable when the profile cannot be read', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));
    vi.spyOn(profile, 'getRatings').mockRejectedValue(new Error('IndexedDB unavailable'));

    renderLibraryApp(profile);

    expect(await screen.findByText('Could not load your library. Try again.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/movies/search?q=heat');
  });

  it('shows the write error and keeps the previous rating when saving a rating fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(3, 4);
    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));

    renderLibraryApp(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const ratingGroup = await screen.findByRole('radiogroup', { name: 'Rating for Heat' });
    const fourStars = within(ratingGroup).getByRole('radio', { name: '4 stars out of 5' });
    await waitFor(() => expect((fourStars as HTMLInputElement).checked).toBe(true));

    vi.spyOn(profile, 'setRating').mockRejectedValue(new Error('Quota exceeded'));

    const oneStar = within(ratingGroup).getByRole('radio', { name: '1 star out of 5' });
    fireEvent.click(oneStar);

    expect(await screen.findByText('Could not save your library change. Try again.')).toBeTruthy();
    expect((oneStar as HTMLInputElement).checked).toBe(false);
    expect((fourStars as HTMLInputElement).checked).toBe(true);
    await expect(profile.ratingsPayload()).resolves.toEqual([{ movieId: 3, rating: 4 }]);
  });

  it('shows the write error and keeps the watched toggle off when saving fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));
    vi.spyOn(profile, 'setWatched').mockRejectedValue(new Error('Quota exceeded'));

    renderLibraryApp(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const watchedButton = await screen.findByRole('button', { name: 'Heat: watched' });
    expect(watchedButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(watchedButton);

    expect(await screen.findByText('Could not save your library change. Try again.')).toBeTruthy();
    expect(watchedButton.getAttribute('aria-pressed')).toBe('false');
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('shows the write error and keeps the watchlist toggle off when saving fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));
    vi.spyOn(profile, 'addToWatchlist').mockRejectedValue(new Error('Quota exceeded'));

    renderLibraryApp(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const watchlistButton = await screen.findByRole('button', { name: 'Heat: watchlist' });
    expect(watchlistButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(watchlistButton);

    expect(await screen.findByText('Could not save your library change. Try again.')).toBeTruthy();
    expect(watchlistButton.getAttribute('aria-pressed')).toBe('false');
    await expect(profile.getWatchlistIds()).resolves.toEqual([]);
  });

  it('shows the taste error without requesting recommendations', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(1, 4);
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'unknown_movie_ids',
            message: 'Some movie ids are missing or have no embedding.',
          },
        },
        400,
      ),
    );

    renderApp(profile);
    await submitPrompt('');

    expect(
      await screen.findByText('Some movie ids are missing or have no embedding.'),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/taste');
  });

  it('excludes active cooldowns from a new round but not expired ones', async () => {
    const now = 1_700_000_000_000;
    const storage = new MemoryGuestProfileStorage();
    const profile = new GuestProfile(storage, { now: () => now });
    const fetchMock = stubFetch();

    storage.seedCooldowns([
      { movieId: 90, expiresAt: now + 1 },
      { movieId: 91, expiresAt: now },
    ]);
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(submittedBody(fetchMock)).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [90],
    });
  });

  it('replaces one alternative in place and records its cooldown', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'Sicario' })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [1, 2, 3, 4],
    });

    const mainPick = screen.getByRole('article', { name: 'Main pick' });
    expect(within(mainPick).getByRole('heading', { name: 'Arrival' })).toBeTruthy();

    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(
      within(alternatives)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Sicario', 'Heat', 'Paddington 2']);
    expect(screen.queryByText('Moonlight')).toBeNull();
    expect(screen.queryByText(TRIM_NOTICE)).toBeNull();

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([2]);
  });

  it('refreshes all picks, cooling every visible one', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const setCooldowns = vi.spyOn(profile, 'setCooldowns');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO, THE_LIGHTHOUSE], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(await screen.findByRole('heading', { name: 'Sicario' })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [1, 2, 3, 4],
    });

    const mainPick = screen.getByRole('article', { name: 'Main pick' });
    expect(within(mainPick).getByRole('heading', { name: 'Sicario' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The Lighthouse' })).toBeTruthy();
    expect(screen.queryByText('Arrival')).toBeNull();

    expect(setCooldowns).toHaveBeenCalledTimes(1);
    expect(setCooldowns).toHaveBeenCalledWith([1, 2, 3, 4]);
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([1, 2, 3, 4]);
  });

  it('moves focus to the replaced pick, never to the main pick on the first round', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [THE_LIGHTHOUSE], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [MOONLIGHT], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('article', { name: 'Main pick' });

    expect(document.activeElement).toBe(document.body);

    // Replacing an alternative must land on the new alternative, while the
    // main pick stays untouched.
    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'Sicario' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Arrival' })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Sicario: not tonight' }),
      ),
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: 'Arrival: not tonight' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'The Lighthouse' })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'The Lighthouse: not tonight' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(await screen.findByRole('heading', { name: 'Moonlight' })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Moonlight: not tonight' }),
      ),
    );
  });

  it('falls back to the results region when a replacement removes the acted-on pick', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Arrival: not tonight' })).toBeNull(),
    );

    const results = document.querySelector('.results');
    const shiftedPick = screen.getByRole('button', { name: 'Moonlight: not tonight' });

    expect(results).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(document.activeElement).not.toBe(shiftedPick);
  });

  it('falls back to the results region when the only pick is replaced with nothing', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('article', { name: 'Main pick' });

    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    const message = await screen.findByText('No picks tonight. Try a different direction.');
    const results = message.closest('section');

    expect(results).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(screen.queryByRole('button', { name: /not tonight/i })).toBeNull();
  });

  it('falls back to the results region when refresh all returns no picks', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    const message = await screen.findByText('No picks tonight. Try a different direction.');
    const results = message.closest('section');

    expect(results).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(screen.queryByRole('button', { name: /not tonight/i })).toBeNull();
  });

  it('excludes films rated or watched after the round from a replacement', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    await profile.setRating(HEAT.id, 4);
    await profile.setWatched(8);

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));
    await screen.findByRole('heading', { name: 'Sicario' });

    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'catalog',
      limit: 4,
      excludeIds: [1, 2, 3, 4, 8],
    });
  });

  it('excludes rated ids beyond the 500-entry taste payload from a replacement', async () => {
    const storage = new MemoryGuestProfileStorage();
    const profile = new GuestProfile(storage);
    const fetchMock = stubFetch();

    storage.seedRatings(
      Array.from({ length: 600 }, (_value, index) => ({
        movieId: index + 1,
        rating: 4,
        updatedAt: index,
      })),
    );

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));
    await screen.findByRole('heading', { name: 'Sicario' });

    expect(submittedBody(fetchMock, 2)).toMatchObject({
      excludeIds: Array.from({ length: 600 }, (_value, index) => index + 1),
    });
  });

  it('keeps the picks and writes no cooldown when a refresh fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'unknown_error',
              message: 'The recommendation service could not complete the request. Try again.',
            },
          },
          500,
        ),
      );

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(
      await screen.findByText(
        'The recommendation service could not complete the request. Try again.',
      ),
    ).toBeTruthy();

    const mainPick = screen.getByRole('article', { name: 'Main pick' });
    expect(within(mainPick).getByRole('heading', { name: 'Arrival' })).toBeTruthy();
    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(3);
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);
    expect(
      (screen.getByRole('button', { name: 'Refresh all' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('keeps the picks and writes nothing when the refresh batch write fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const setCooldowns = vi
      .spyOn(profile, 'setCooldowns')
      .mockRejectedValue(new Error('Quota exceeded'));

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO, THE_LIGHTHOUSE], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(
      await screen.findByText('Could not refresh the picks. Your picks are unchanged.'),
    ).toBeTruthy();

    expect(setCooldowns).toHaveBeenCalledTimes(1);
    expect(setCooldowns).toHaveBeenCalledWith([1, 2, 3, 4]);

    const mainPick = screen.getByRole('article', { name: 'Main pick' });
    expect(within(mainPick).getByRole('heading', { name: 'Arrival' })).toBeTruthy();
    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(3);
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    expect(screen.queryByText('Sicario')).toBeNull();
    expect(screen.queryByText('The Lighthouse')).toBeNull();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);
  });

  it('shows a quiet notice when a replacement trims the exclusion set', async () => {
    const storage = new MemoryGuestProfileStorage();
    const profile = new GuestProfile(storage);
    const fetchMock = stubFetch();

    storage.seedRatings(
      Array.from({ length: 10_004 }, (_value, index) => ({
        movieId: index + 1,
        rating: 4,
        updatedAt: index,
      })),
    );

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasteVector: TASTE_VECTOR }))
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'Sicario' })).toBeTruthy();
    expect(screen.getByText(TRIM_NOTICE)).toBeTruthy();

    const excludeIds = submittedBody(fetchMock, 2).excludeIds as number[];

    expect(excludeIds).toHaveLength(MAX_EXCLUDE_IDS);
    expect(excludeIds).toContain(10_000);
  });

  it('keeps the picks and writes no cooldown when a replacement fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'unknown_error',
              message: 'The recommendation service could not complete the request. Try again.',
            },
          },
          500,
        ),
      );

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));

    expect(
      await screen.findByText(
        'The recommendation service could not complete the request. Try again.',
      ),
    ).toBeTruthy();

    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(3);
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);

    const moonNightButton = screen.getByRole('button', { name: 'Moonlight: not tonight' });
    expect((moonNightButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('removes the slot when a replacement returns no movie', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockResolvedValueOnce(jsonResponse({ movies: [], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Heat: not tonight' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Alternatives' })).getAllByRole('listitem'),
      ).toHaveLength(2),
    );
    expect(screen.queryByText('Heat')).toBeNull();
    expect(screen.getByRole('article', { name: 'Main pick' })).toBeTruthy();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([3]);
  });

  it('shows a single pick without alternatives and handles its replacement', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('article', { name: 'Main pick' });

    expect(screen.queryByRole('list', { name: 'Alternatives' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh all' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Arrival: not tonight' }));

    expect(await screen.findByText('No picks tonight. Try a different direction.')).toBeTruthy();
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([1]);
  });

  it('blocks other pick actions while a replacement is in flight', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2], coldStart: false }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => undefined));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const pendingButton = screen.getByRole('button', { name: 'Moonlight: not tonight' });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect(pendingButton.textContent).toBe('Finding another…');

    const heatButton = screen.getByRole('button', { name: 'Heat: not tonight' });
    expect((heatButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Refresh all' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(heatButton);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('imports a pasted list and requests recommendations from its matched films', async () => {
    const fetchMock = stubFetch();
    const pasted = 'Heat (1995)\nThe Lighthouse\nNot A Film, 2001';

    fetchMock.mockImplementation(async (input) => {
      if (input === '/api/imports/letterboxd') {
        return importResponse([3, 7], [{ name: 'Not A Film', year: 2001 }]);
      }

      return jsonResponse({ movies: [HEAT], coldStart: false });
    });

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.change(getPasteInput(), { target: { value: pasted } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));

    expect(await screen.findByText('Matched 2 of 3 films from your list.')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/imports/letterboxd');
    expect(submittedBody(fetchMock, 0)).toEqual({
      csv: 'Date,Name,Year,Letterboxd URI\n,Heat,1995,\n,The Lighthouse,,\n,Not A Film,2001,',
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [3, 7],
    });
    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeTruthy();

    const unmatchedSummary = screen.getByText('Not in the catalog: 1 film');
    expect(unmatchedSummary.closest('details')?.open).toBe(false);
    fireEvent.click(unmatchedSummary);
    expect(screen.getByText('Not A Film (2001)')).toBeTruthy();

    // The paste stays available for the rest of the session.
    selectSource('The whole catalog');
    selectSource("A list I'll paste");
    expect(getPasteInput().value).toBe(pasted);
  });

  it('shows pasted lines it cannot read and recommends from the rest', async () => {
    const fetchMock = stubFetch();

    fetchMock.mockImplementation(async (input) => {
      if (input === '/api/imports/letterboxd') {
        return importResponse([3]);
      }

      return jsonResponse({ movies: [HEAT], coldStart: false });
    });

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.change(getPasteInput(), { target: { value: 'Heat\n—' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));

    expect(await screen.findByText('Matched 1 of 1 film from your list.')).toBeTruthy();

    const unparseableSummary = screen.getByText('Could not read: 1 line');
    fireEvent.click(unparseableSummary);
    expect(screen.getByText('—')).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(submittedBody(fetchMock, 1)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [3],
    });
  });

  it('shows the paste empty state and skips recommendations when nothing matched', async () => {
    const fetchMock = stubFetch();

    fetchMock.mockResolvedValue(importResponse([], [{ name: 'Sátántangó', year: 1994 }]));

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.change(getPasteInput(), { target: { value: 'Sátántangó, 1994' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));

    expect(await screen.findByText('No films from that list are in the catalog yet.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/imports/letterboxd');
    expect(screen.getByText('Sátántangó (1994)')).toBeTruthy();
  });

  it('keeps a pasted round on the pool its import matched', async () => {
    const fetchMock = stubFetch();

    fetchMock
      .mockResolvedValueOnce(importResponse([3, 6, 7]))
      .mockResolvedValueOnce(jsonResponse({ movies: [HEAT, SICARIO], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [THE_LIGHTHOUSE], coldStart: false }));

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.change(getPasteInput(), { target: { value: 'Heat\nSicario\nThe Lighthouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));
    await screen.findByRole('heading', { name: 'Sicario' });

    // Changing the textarea must not change a round that is already running.
    fireEvent.change(getPasteInput(), { target: { value: 'Alien, 1979' } });
    fireEvent.click(screen.getByRole('button', { name: 'Heat: not tonight' }));

    expect(await screen.findByRole('heading', { name: 'The Lighthouse' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submittedBody(fetchMock, 2)).toEqual({
      source: 'list',
      limit: 4,
      candidateIds: [3, 6, 7],
      excludeIds: [3, 6],
    });

    const importCalls = fetchMock.mock.calls.filter(
      ([input]) => input === '/api/imports/letterboxd',
    );
    expect(importCalls).toHaveLength(1);
  });

  it('rejects a paste beyond the import size limit without calling the API', async () => {
    const fetchMock = stubFetch();

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.change(getPasteInput(), { target: { value: 'x'.repeat(200_001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));

    expect(await screen.findByText(LIST_PASTE_TOO_LONG_MESSAGE)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a list when Use this list is pressed with an empty textarea', async () => {
    const fetchMock = stubFetch();

    renderApp();
    selectSource("A list I'll paste");
    fireEvent.click(screen.getByRole('button', { name: 'Use this list' }));

    expect(await screen.findByText('Paste a list first — one film per line.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends exploration 0.5 when Surprise me is on', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL], coldStart: false }));

    renderApp();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Surprise me' }));
    await submitPrompt('  something strange  ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(submittedBody(fetchMock)).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'something strange',
      exploration: 0.5,
    });
  });

  it('records a completed round with its source, trimmed prompt and shown picks', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.addToWatchlist(HEAT.id);
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }));

    renderApp(profile);
    selectSource('My watchlist');
    await submitPrompt('  comfort films  ');
    await screen.findByRole('heading', { name: 'Arrival' });

    const [entry] = await waitForHistory(profile, 1);

    expect(entry).toMatchObject({
      kind: 'round',
      source: 'watchlist',
      prompt: 'comfort films',
      replacedMovieId: null,
    });
    expect(entry?.movies).toEqual([ARRIVAL, MOONLIGHT].map(movieSnapshot));
  });

  it('records a replacement with the rejected pick and the merged picks', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, MOONLIGHT, HEAT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Moonlight: not tonight' }));
    await screen.findByRole('heading', { name: 'Sicario' });

    const history = await waitForHistory(profile, 2);

    expect(history.map((entry) => entry.kind)).toEqual(['replace', 'round']);
    expect(history[0]).toMatchObject({
      kind: 'replace',
      source: 'catalog',
      prompt: '',
      replacedMovieId: MOONLIGHT.id,
    });
    expect(history[0]?.movies).toEqual([ARRIVAL, SICARIO, HEAT].map(movieSnapshot));
  });

  it('records a refresh with the new picks', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }))
      .mockResolvedValueOnce(jsonResponse({ movies: [SICARIO, THE_LIGHTHOUSE], coldStart: false }));

    renderApp(profile);
    await submitPrompt('cozy');
    await screen.findByRole('list', { name: 'Alternatives' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));
    await screen.findByRole('heading', { name: 'Sicario' });

    const [entry] = await waitForHistory(profile, 2);

    expect(entry).toMatchObject({
      kind: 'refresh',
      source: 'catalog',
      prompt: 'cozy',
      replacedMovieId: null,
    });
    expect(entry?.movies).toEqual([SICARIO, THE_LIGHTHOUSE].map(movieSnapshot));
  });

  it('records no history when the recommendation request fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many recommendation requests. Try again later.',
          },
        },
        429,
      ),
    );

    renderApp(profile);
    await submitPrompt('');

    expect(
      await screen.findByText('Too many recommendation requests. Try again later.'),
    ).toBeTruthy();
    await expect(profile.getHistory()).resolves.toEqual([]);
  });

  it('records no history when a round returns no movies', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockResolvedValue(jsonResponse({ movies: [], coldStart: true }));

    renderApp(profile);
    await submitPrompt('something impossible');

    expect(await screen.findByText('No picks tonight. Try a different direction.')).toBeTruthy();
    await expect(profile.getHistory()).resolves.toEqual([]);
  });

  it('keeps showing picks when the history write fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const recordRound = vi
      .spyOn(profile, 'recordRound')
      .mockRejectedValue(new Error('Quota exceeded'));

    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL, MOONLIGHT], coldStart: false }));

    renderApp(profile);
    await submitPrompt('');

    expect(await screen.findByRole('heading', { name: 'Arrival' })).toBeTruthy();
    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getByText('Moonlight')).toBeTruthy();
    expect(document.querySelector('.status--error')).toBeNull();
    await waitFor(() => expect(recordRound).toHaveBeenCalledTimes(1));
  });
});

describe('view navigation', () => {
  it('defaults to the picks view and follows hash changes between views', async () => {
    const fetchMock = stubFetch();

    render(<App profile={createProfile()} />);

    expect(getPromptInput()).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your library' })).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();
    expect(screen.getByRole('link', { name: 'Picks' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull();

    navigateTo('library');

    expect(await screen.findByRole('heading', { name: 'Your library' })).toBeTruthy();
    const libraryTabs = screen.getByRole('navigation', { name: 'Library sections' });
    expect(
      within(libraryTabs)
        .getByRole('link', { name: /^Rated/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(libraryTabs)
        .getByRole('link', { name: /^Watchlist/ })
        .getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Picks' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByLabelText('What are you in the mood for?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Find my movie' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your dashboard' })).toBeNull();

    navigateTo('dashboard');

    expect(await screen.findByRole('heading', { name: 'Your dashboard' })).toBeTruthy();
    expect(screen.queryByLabelText('What are you in the mood for?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Find my movie' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your library' })).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Picks' }).getAttribute('aria-current')).toBeNull();

    navigateTo('picks');

    expect(await screen.findByLabelText('What are you in the mood for?')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your dashboard' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your library' })).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();
    expect(screen.getByRole('link', { name: 'Picks' }).getAttribute('aria-current')).toBe('page');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('moves focus to the main content after a hash navigation but not on first render', async () => {
    window.history.replaceState(null, '', '#picks');

    render(<App profile={createProfile()} />);

    expect(document.activeElement).toBe(document.body);

    navigateTo('library');

    expect(await screen.findByRole('heading', { name: 'Your library' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('leaves focus alone when a hash change does not change the view', () => {
    render(<App profile={createProfile()} />);

    const promptInput = getPromptInput();
    promptInput.focus();

    window.history.replaceState(null, '', '#in-page-anchor');
    fireEvent(window, new Event('hashchange'));

    expect(document.activeElement).toBe(promptInput);
    expect(getPromptInput()).toBe(promptInput);
  });

  it('opens the library on the rated tab by default', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(3, 4.5);
    fetchMock.mockResolvedValue(jsonResponse({ movie: HEAT }));
    window.history.replaceState(null, '', '#library');

    render(<App profile={profile} />);

    expect(await screen.findByRole('heading', { name: 'Your library' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Library sections' });
    expect(
      within(tabs)
        .getByRole('link', { name: /^Rated/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByLabelText('What are you in the mood for?')).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();
    expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');

    const list = await screen.findByRole('list', { name: 'Rated films' });
    expect(await within(list).findByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(within(list).getByText('1995')).toBeTruthy();
    expect(within(list).getByText('4½ / 5')).toBeTruthy();
  });

  it('opens the watchlist tab from a library watchlist hash', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.addToWatchlist(3);
    fetchMock.mockResolvedValue(jsonResponse({ movie: HEAT }));
    window.history.replaceState(null, '', '#library/watchlist');

    render(<App profile={profile} />);

    expect(await screen.findByRole('heading', { name: 'Your library' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Library sections' });
    expect(
      within(tabs)
        .getByRole('link', { name: /^Watchlist/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(tabs)
        .getByRole('link', { name: /^Rated/ })
        .getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.queryByLabelText('Find a film to rate')).toBeNull();

    const list = await screen.findByRole('list', { name: 'Watchlist films' });
    expect(await within(list).findByRole('heading', { name: 'Heat' })).toBeTruthy();
    expect(within(list).getByText('1995')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Remove Heat from watchlist' })).toBeTruthy();
  });

  it('opens the find tab from a library find hash', async () => {
    window.history.replaceState(null, '', '#library/find');

    render(<App profile={createProfile()} />);

    expect(await screen.findByRole('heading', { name: 'Your library' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Library sections' });
    expect(
      within(tabs).getByRole('link', { name: 'Find films' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByLabelText('Find a film to rate')).toBeTruthy();
    expect(screen.queryByText(/No rated films yet/)).toBeNull();
    expect(screen.queryByText(/Nothing on your watchlist yet/)).toBeNull();
  });

  it('opens the dashboard when the app loads with a dashboard hash', async () => {
    window.history.replaceState(null, '', '#dashboard');

    render(<App profile={createProfile()} />);

    expect(await screen.findByRole('heading', { name: 'Your dashboard' })).toBeTruthy();
    expect(screen.queryByLabelText('What are you in the mood for?')).toBeNull();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});
