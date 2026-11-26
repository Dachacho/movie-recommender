import { EXPECTED_EMBEDDING_DIMENSIONS } from './types.js';

export const PROMPT_WEIGHT = 0.5;
export const TASTE_WEIGHT = 0.5;
export const MIN_COMBINED_NORM = 1e-9;

export interface CombineQueryVectorInput {
  promptVector?: readonly number[] | null;
  tasteVector?: readonly number[] | null;
  /** Defaults to {@link PROMPT_WEIGHT}; must be finite and non-negative. */
  promptWeight?: number;
  /** Defaults to {@link TASTE_WEIGHT}; must be finite and non-negative. */
  tasteWeight?: number;
}

function validateWeight(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number, received ${value}.`);
  }
}

function validateVector(vector: readonly number[], name: string): void {
  if (vector.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new RangeError(
      `${name} must have exactly ${EXPECTED_EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}.`,
    );
  }

  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];

    if (value === undefined || !Number.isFinite(value)) {
      throw new RangeError(`${name}[${index}] must be a finite number, received ${value}.`);
    }
  }
}

/**
 * Combines an already normalized prompt vector and taste vector into the query vector used for
 * ranking. Inputs are validated but not transformed; the result is always unit length unless it
 * falls back to the prompt vector alone.
 */
export function combineQueryVector(input: CombineQueryVectorInput): number[] | null {
  const promptVector = input.promptVector ?? null;
  const tasteVector = input.tasteVector ?? null;
  const promptWeight = input.promptWeight ?? PROMPT_WEIGHT;
  const tasteWeight = input.tasteWeight ?? TASTE_WEIGHT;

  validateWeight(promptWeight, 'promptWeight');
  validateWeight(tasteWeight, 'tasteWeight');

  if (promptVector !== null) {
    validateVector(promptVector, 'promptVector');
  }

  if (tasteVector !== null) {
    validateVector(tasteVector, 'tasteVector');
  }

  if (tasteVector === null) {
    return promptVector === null ? null : [...promptVector];
  }

  if (promptVector === null) {
    return [...tasteVector];
  }

  const combined = new Array<number>(EXPECTED_EMBEDDING_DIMENSIONS).fill(0);
  let norm = 0;

  for (let index = 0; index < combined.length; index += 1) {
    const value =
      promptWeight * (promptVector[index] ?? 0) + tasteWeight * (tasteVector[index] ?? 0);

    combined[index] = value;
    norm = Math.hypot(norm, value);
  }

  if (!Number.isFinite(norm) || norm <= MIN_COMBINED_NORM) {
    // Opposite vectors cancel out; the prompt carries the explicit request, so prefer it.
    return [...promptVector];
  }

  return combined.map((value) => value / norm);
}
