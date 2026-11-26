import { describe, expect, it } from 'vitest';
import { parsePromptConstraints } from '../modules/recommendations/constraints.js';
import { CANONICAL_GENRES, PROMPT_CASES, type PromptCaseGroup } from './prompt-cases.js';

const GROUPS: readonly PromptCaseGroup[] = ['explicit', 'soft', 'edge', 'control'];
const CANONICAL = new Set<string>(CANONICAL_GENRES);

describe('prompt case dataset', () => {
  it('contains at least 24 cases across all four groups', () => {
    expect(PROMPT_CASES.length).toBeGreaterThanOrEqual(24);

    for (const group of GROUPS) {
      expect(
        PROMPT_CASES.filter((promptCase) => promptCase.group === group).length,
      ).toBeGreaterThan(0);
    }
  });

  it('uses unique ids and prompts', () => {
    expect(new Set(PROMPT_CASES.map((promptCase) => promptCase.id)).size).toBe(PROMPT_CASES.length);
    expect(new Set(PROMPT_CASES.map((promptCase) => promptCase.prompt)).size).toBe(
      PROMPT_CASES.length,
    );
  });

  it('labels genre relevance only with canonical genres and values in (0, 1]', () => {
    for (const promptCase of PROMPT_CASES) {
      for (const [genre, weight] of Object.entries(promptCase.genreWeights)) {
        expect(CANONICAL.has(genre)).toBe(true);
        expect(Number.isFinite(weight)).toBe(true);
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps controls unconstrained and unlabelled', () => {
    for (const promptCase of PROMPT_CASES.filter((entry) => entry.group === 'control')) {
      expect(promptCase.expectedFilters).toBeUndefined();
      expect(promptCase.genreWeights).toEqual({});
    }
  });

  it('keeps soft prompts free of hard filters but keeps their genre labels', () => {
    for (const promptCase of PROMPT_CASES.filter((entry) => entry.group === 'soft')) {
      expect(promptCase.expectedFilters).toBeUndefined();
      expect(Object.keys(promptCase.genreWeights).length).toBeGreaterThan(0);
    }
  });
});

describe('parsePromptConstraints against the labelled prompt set', () => {
  for (const promptCase of PROMPT_CASES) {
    it(`${promptCase.group}/${promptCase.id}: ${promptCase.prompt}`, () => {
      expect(parsePromptConstraints(promptCase.prompt)).toEqual(promptCase.expectedFilters);
    });
  }
});
