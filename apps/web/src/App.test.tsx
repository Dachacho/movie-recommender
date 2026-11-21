import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { App } from './App';
import { GuestProfile } from './profile/GuestProfile';
import { MemoryGuestProfileStorage } from './profile/memoryStorage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

function renderApp(profile: GuestProfile = createProfile()): ReturnType<typeof render> {
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

describe('App', () => {
  it('shows the heading, prompt label and button before any request', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Movie recommender' })).toBeTruthy();
    expect(getPromptInput().value).toBe('');
    expect(screen.getByRole('button', { name: 'Find my movie' })).toBeTruthy();
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

    const alternatives = screen.getByRole('list', { name: 'Alternatives' });
    expect(within(alternatives).getAllByRole('listitem')).toHaveLength(3);
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

  it('requests a taste vector and excludes watched movies from recommendations', async () => {
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
      excludeIds: [3],
    });
  });

  it('calls only recommendations when the guest has no ratings', async () => {
    const fetchMock = stubTasteAndRecommendations(TASTE_VECTOR);

    renderApp();
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock)).toEqual({ source: 'catalog', limit: 4 });
  });

  it('continues without a taste vector when the taste response is null', async () => {
    const fetchMock = stubTasteAndRecommendations(null);
    const profile = createProfile();

    await profile.setRating(1, 2);

    renderApp(profile);
    await submitPrompt('');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/taste');
    expect(submittedBody(fetchMock, 1)).toEqual({ source: 'catalog', limit: 4 });
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

    renderApp();
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

    renderApp();
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

    renderApp();
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

    renderApp(profile);
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

    renderApp(profile);
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

    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const ratingGroup = await screen.findByRole('radiogroup', { name: 'Rating for Heat' });
    const threeStars = within(ratingGroup).getByRole('radio', { name: '3 stars out of 5' });
    fireEvent.click(threeStars);
    await waitFor(() => expect((threeStars as HTMLInputElement).checked).toBe(true));

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

    renderApp(profile);

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

    renderApp(profile);
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

    renderApp(profile);
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

    renderApp(profile);
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
});
