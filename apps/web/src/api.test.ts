import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  RecommendationApiError,
  RecommendationNetworkError,
  fetchRecommendations,
  fetchTasteVector,
  importLetterboxd,
  searchMovies,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MOVIE: MovieCard = {
  id: 1,
  title: 'Arrival',
  releaseYear: 2016,
  runtime: 116,
  overview: 'A linguist is recruited by the military to communicate with alien lifeforms.',
  genres: ['Science Fiction', 'Drama'],
  director: 'Denis Villeneuve',
  cast: ['Amy Adams'],
  posterPath: '/arrival.jpg',
  voteAverage: 7.6,
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

function submittedBody(fetchMock: Mock<typeof fetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];

  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('fetch call has no JSON body');
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('fetchRecommendations', () => {
  it('posts a catalog request and returns the parsed response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [MOVIE], coldStart: false }));

    const result = await fetchRecommendations({
      source: 'catalog',
      limit: 4,
      prompt: 'quiet science fiction',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/recommendations');
    expect(submittedBody(fetchMock)).toEqual({
      source: 'catalog',
      limit: 4,
      prompt: 'quiet science fiction',
    });
    expect(result).toEqual({ movies: [MOVIE], coldStart: false });
  });

  it('rejects with the API error code and message for a non-2xx response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'invalid_request', message: 'prompt must be 300 characters or fewer' } },
        400,
      ),
    );

    await expect(fetchRecommendations({ source: 'catalog', limit: 4 })).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_request',
      message: 'prompt must be 300 characters or fewer',
    });
  });

  it('falls back to a structured error when a non-2xx body is not an API error', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse('<html>gateway timeout</html>', 502));

    const error: unknown = await fetchRecommendations({ source: 'catalog', limit: 4 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RecommendationApiError);
    expect(error).toMatchObject({
      code: 'unknown_error',
      message: 'The recommendation service could not complete the request. Try again.',
    });
  });

  it('rejects an unexpected success payload instead of returning it', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [{ title: 'Not a movie card' }] }));

    await expect(fetchRecommendations({ source: 'catalog', limit: 4 })).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_response',
    });
  });

  it('rejects with a network error when fetch fails', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error: unknown = await fetchRecommendations({ source: 'catalog', limit: 4 }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RecommendationNetworkError);
    expect(error).toMatchObject({
      message: 'Could not reach the recommendation service. Check your connection and try again.',
    });
  });
});

const TASTE_VECTOR = Array.from({ length: 384 }, (_value, index) => (index === 0 ? 1 : 0));

describe('fetchTasteVector', () => {
  it('posts the ratings and returns the parsed taste vector', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ tasteVector: TASTE_VECTOR }));

    const ratings = [
      { movieId: 7, rating: 4.5 },
      { movieId: 3, rating: 2 },
    ];
    const result = await fetchTasteVector(ratings);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/taste');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(submittedBody(fetchMock)).toEqual({ ratings });
    expect(result).toEqual(TASTE_VECTOR);
  });

  it('returns null for a cold-start taste response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ tasteVector: null }));

    await expect(fetchTasteVector([{ movieId: 7, rating: 2.5 }])).resolves.toBeNull();
  });

  it('rejects with the API error code and message for a non-2xx response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'unknown_movie_ids', message: 'Some movie ids are missing.' } },
        400,
      ),
    );

    await expect(fetchTasteVector([{ movieId: 7, rating: 4 }])).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'unknown_movie_ids',
      message: 'Some movie ids are missing.',
    });
  });

  it('rejects an unexpected success payload instead of returning it', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ tasteVector: [1, 2, 3] }));

    await expect(fetchTasteVector([{ movieId: 7, rating: 4 }])).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_response',
      message: 'The taste service returned an unexpected response. Try again.',
    });
  });

  it('rejects with a network error when fetch fails', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchTasteVector([{ movieId: 7, rating: 4 }])).rejects.toBeInstanceOf(
      RecommendationNetworkError,
    );
  });
});

describe('searchMovies', () => {
  it('requests the trimmed query and returns the parsed movie list', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [MOVIE] }));

    const result = await searchMovies('  arrival  ');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/movies/search?q=arrival');
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined();
    expect(result).toEqual([MOVIE]);
  });

  it('encodes a query with spaces', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [] }));

    await searchMovies('paddington 2');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/movies/search?q=paddington+2');
  });

  it.each(['', ' a ', 'x'.repeat(81)])(
    'rejects an out-of-range query without calling fetch: %j',
    async (query) => {
      const fetchMock = stubFetch();

      await expect(searchMovies(query)).rejects.toMatchObject({
        name: 'RecommendationApiError',
        code: 'invalid_query',
        message: 'Enter a search term between 2 and 80 characters.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects with the API error code and message for a non-2xx response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'invalid_request', message: 'Invalid search query.' } }, 400),
    );

    await expect(searchMovies('arrival')).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_request',
      message: 'Invalid search query.',
    });
  });

  it('rejects an unexpected success payload instead of returning it', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ movies: [{ title: 'Not a movie card' }] }));

    await expect(searchMovies('arrival')).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_response',
      message: 'The movie search returned an unexpected response. Try again.',
    });
  });

  it('rejects with a network error when fetch fails', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(searchMovies('arrival')).rejects.toBeInstanceOf(RecommendationNetworkError);
  });
});

const IMPORT_RESPONSE = {
  matched: [
    { movieId: 11, title: 'Arrival', releaseYear: 2016, rating: 4.5 },
    { movieId: 12, title: 'Heat', releaseYear: 1995, rating: null },
  ],
  unmatched: [{ name: 'The Long Goodbye', year: 1973, reason: 'no_match' }],
  stats: { rows: 3, matched: 2, unmatched: 1, invalid: 0 },
};

describe('importLetterboxd', () => {
  it('posts the CSV and returns the parsed import report', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(IMPORT_RESPONSE));

    const result = await importLetterboxd('Name,Year,Rating\nArrival,2016,4.5');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/imports/letterboxd');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(submittedBody(fetchMock)).toEqual({ csv: 'Name,Year,Rating\nArrival,2016,4.5' });
    expect(result).toEqual(IMPORT_RESPONSE);
  });

  it.each(['', 'x'.repeat(200_001)])(
    'rejects an out-of-range CSV without calling fetch',
    async (csv) => {
      const fetchMock = stubFetch();

      await expect(importLetterboxd(csv)).rejects.toMatchObject({
        name: 'RecommendationApiError',
        code: 'invalid_request',
        message: 'Choose a non-empty Letterboxd CSV export of up to 200,000 characters.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects with the API error code and message for a non-2xx response', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'invalid_csv', message: 'CSV must include a Name column.' } },
        400,
      ),
    );

    await expect(importLetterboxd('Name\nArrival')).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_csv',
      message: 'CSV must include a Name column.',
    });
  });

  it('rejects an unexpected success payload instead of returning it', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse({ matched: 'not an array' }));

    await expect(importLetterboxd('Name\nArrival')).rejects.toMatchObject({
      name: 'RecommendationApiError',
      code: 'invalid_response',
      message: 'The import service returned an unexpected response. Try again.',
    });
  });

  it('rejects with a network error when fetch fails', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(importLetterboxd('Name\nArrival')).rejects.toBeInstanceOf(
      RecommendationNetworkError,
    );
  });
});
