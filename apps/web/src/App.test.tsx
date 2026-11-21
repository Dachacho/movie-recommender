import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { App } from './App';

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

function submittedBody(fetchMock: Mock<typeof fetch>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];

  if (call === undefined) {
    throw new Error('fetch was not called');
  }

  const init = call[1];

  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('fetch call has no JSON body');
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

async function submitPrompt(prompt: string): Promise<void> {
  fireEvent.change(getPromptInput(), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Find my movie' }));
}

describe('App', () => {
  it('shows the heading, prompt label and button before any request', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Movie recommender' })).toBeTruthy();
    expect(getPromptInput().value).toBe('');
    expect(screen.getByRole('button', { name: 'Find my movie' })).toBeTruthy();
  });

  it('posts a trimmed prompt when the input is not empty', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [ARRIVAL], coldStart: false }));

    render(<App />);
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

    render(<App />);
    await submitPrompt('   ');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(submittedBody(fetchMock)).toEqual({ source: 'catalog', limit: 4 });
  });

  it('does not send another request while one is pending', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    render(<App />);
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

    render(<App />);
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

    render(<App />);
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

    render(<App />);
    await submitPrompt('');

    expect(
      await screen.findByRole('img', { name: 'No poster available for Paddington 2' }),
    ).toBeTruthy();
  });

  it('falls back to the placeholder when a poster image fails to load', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [BROKEN_POSTER], coldStart: false }));

    render(<App />);
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

    render(<App />);
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

    render(<App />);
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

    render(<App />);
    await submitPrompt('');

    expect(
      await screen.findByText(
        'Could not reach the recommendation service. Check your connection and try again.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find my movie' })).toBeTruthy();
  });
});
