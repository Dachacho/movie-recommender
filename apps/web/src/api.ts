import {
  apiErrorSchema,
  recommendationResponseSchema,
  tasteResponseSchema,
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
