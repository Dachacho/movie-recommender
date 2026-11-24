import {
  apiErrorSchema,
  letterboxdImportRequestSchema,
  letterboxdImportResponseSchema,
  movieDetailResponseSchema,
  movieListResponseSchema,
  movieSearchQuerySchema,
  recommendationResponseSchema,
  tasteResponseSchema,
  type LetterboxdImportResponse,
  type MovieCard,
  type RecommendationRequest,
  type RecommendationResponse,
  type TasteRequest,
  type TasteResponse,
} from '@movie-recommender/shared';

const NETWORK_ERROR_MESSAGE =
  'Could not reach the recommendation service. Check your connection and try again.';

const UNEXPECTED_ERROR_MESSAGE =
  'The recommendation service could not complete the request. Try again.';
const INVALID_RESPONSE_MESSAGE =
  'The recommendation service returned an unexpected response. Try again.';
const INVALID_TASTE_RESPONSE_MESSAGE =
  'The taste service returned an unexpected response. Try again.';
const INVALID_SEARCH_QUERY_MESSAGE = 'Enter a search term between 2 and 80 characters.';
const INVALID_SEARCH_RESPONSE_MESSAGE =
  'The movie search returned an unexpected response. Try again.';
const INVALID_MOVIE_RESPONSE_MESSAGE =
  'The movie lookup returned an unexpected response. Try again.';
const MAX_MOVIE_ID = 2_147_483_647;
const INVALID_MOVIE_ID_MESSAGE = `Movie id must be an integer between 1 and ${MAX_MOVIE_ID}.`;
const INVALID_IMPORT_CSV_MESSAGE =
  'Choose a non-empty Letterboxd CSV export of up to 200,000 characters.';
const INVALID_IMPORT_RESPONSE_MESSAGE =
  'The import service returned an unexpected response. Try again.';

export class RecommendationApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecommendationApiError';
    this.code = code;
  }
}

export class RecommendationNetworkError extends Error {
  constructor() {
    super(NETWORK_ERROR_MESSAGE);
    this.name = 'RecommendationNetworkError';
  }
}

export type TasteVector = TasteResponse['tasteVector'];

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function apiErrorFromPayload(payload: unknown, fallbackCode: string): RecommendationApiError {
  const parsed = apiErrorSchema.safeParse(payload);

  if (parsed.success) {
    return new RecommendationApiError(parsed.data.error.code, parsed.data.error.message);
  }

  return new RecommendationApiError(fallbackCode, UNEXPECTED_ERROR_MESSAGE);
}

export async function fetchTasteVector(ratings: TasteRequest['ratings']): Promise<TasteVector> {
  const request: TasteRequest = { ratings };

  let response: Response;

  try {
    response = await fetch('/api/taste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new RecommendationNetworkError();
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromPayload(payload, 'unknown_error');
  }

  const parsed = tasteResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new RecommendationApiError('invalid_response', INVALID_TASTE_RESPONSE_MESSAGE);
  }

  return parsed.data.tasteVector;
}

export async function searchMovies(query: string): Promise<MovieCard[]> {
  const parsedQuery = movieSearchQuerySchema.safeParse({ q: query });

  if (!parsedQuery.success) {
    throw new RecommendationApiError('invalid_query', INVALID_SEARCH_QUERY_MESSAGE);
  }

  const params = new URLSearchParams({ q: parsedQuery.data.q });

  let response: Response;

  try {
    response = await fetch(`/api/movies/search?${params.toString()}`);
  } catch {
    throw new RecommendationNetworkError();
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromPayload(payload, 'unknown_error');
  }

  const parsed = movieListResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new RecommendationApiError('invalid_response', INVALID_SEARCH_RESPONSE_MESSAGE);
  }

  return parsed.data.movies;
}

export async function fetchMovie(movieId: number): Promise<MovieCard | null> {
  if (!Number.isInteger(movieId) || movieId < 1 || movieId > MAX_MOVIE_ID) {
    throw new RecommendationApiError('invalid_movie_id', INVALID_MOVIE_ID_MESSAGE);
  }

  let response: Response;

  try {
    response = await fetch(`/api/movies/${movieId}`);
  } catch {
    throw new RecommendationNetworkError();
  }

  if (response.status === 404) {
    return null;
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromPayload(payload, 'unknown_error');
  }

  const parsed = movieDetailResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new RecommendationApiError('invalid_response', INVALID_MOVIE_RESPONSE_MESSAGE);
  }

  return parsed.data.movie;
}

export async function importLetterboxd(csv: string): Promise<LetterboxdImportResponse> {
  const parsedRequest = letterboxdImportRequestSchema.safeParse({ csv });

  if (!parsedRequest.success) {
    throw new RecommendationApiError('invalid_request', INVALID_IMPORT_CSV_MESSAGE);
  }

  let response: Response;

  try {
    response = await fetch('/api/imports/letterboxd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsedRequest.data),
    });
  } catch {
    throw new RecommendationNetworkError();
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromPayload(payload, 'unknown_error');
  }

  const parsed = letterboxdImportResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new RecommendationApiError('invalid_response', INVALID_IMPORT_RESPONSE_MESSAGE);
  }

  return parsed.data;
}

export async function fetchRecommendations(
  request: RecommendationRequest,
): Promise<RecommendationResponse> {
  let response: Response;

  try {
    response = await fetch('/api/recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new RecommendationNetworkError();
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromPayload(payload, 'unknown_error');
  }

  const parsed = recommendationResponseSchema.safeParse(payload);

  if (!parsed.success) {
    throw new RecommendationApiError('invalid_response', INVALID_RESPONSE_MESSAGE);
  }

  return parsed.data;
}
