import {
  apiErrorSchema,
  recommendationResponseSchema,
  type RecommendationRequest,
  type RecommendationResponse,
} from '@movie-recommender/shared';

const NETWORK_ERROR_MESSAGE =
  'Could not reach the recommendation service. Check your connection and try again.';

const UNEXPECTED_ERROR_MESSAGE =
  'The recommendation service could not complete the request. Try again.';
const INVALID_RESPONSE_MESSAGE =
  'The recommendation service returned an unexpected response. Try again.';

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

export interface RecommendationInput {
  prompt?: string;
}

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

export async function fetchRecommendations(
  input: RecommendationInput,
): Promise<RecommendationResponse> {
  const request: RecommendationRequest = {
    source: 'catalog',
    limit: 4,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  };

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
