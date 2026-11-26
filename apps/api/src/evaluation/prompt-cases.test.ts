import { describe, expect, it } from 'vitest';
import { parsePromptConstraints } from '../modules/recommendations/constraints.js';
import { parsePromptMood } from '../modules/recommendations/mood.js';
import { CANONICAL_GENRES, PROMPT_CASES, type PromptCaseGroup } from './prompt-cases.js';

const GROUPS: readonly PromptCaseGroup[] = ['explicit', 'soft', 'edge', 'control'];
const CANONICAL = new Set<string>(CANONICAL_GENRES);

function countGroup(group: PromptCaseGroup): number {
  return PROMPT_CASES.filter((promptCase) => promptCase.group === group).length;
}

describe('prompt case dataset', () => {
  it('contains the counted set across all four groups', () => {
    expect(PROMPT_CASES).toHaveLength(35);
    expect(Object.fromEntries(GROUPS.map((group) => [group, countGroup(group)]))).toEqual({
      explicit: 7,
      soft: 11,
      edge: 11,
      control: 6,
    });
    expect(
      PROMPT_CASES.filter((promptCase) => promptCase.expectedFilters !== undefined),
    ).toHaveLength(16);
    expect(
      PROMPT_CASES.filter((promptCase) => Object.keys(promptCase.genreWeights).length > 0),
    ).toHaveLength(24);
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

  it('keeps soft prompts semantically labelled', () => {
    for (const promptCase of PROMPT_CASES.filter((entry) => entry.group === 'soft')) {
      expect(Object.keys(promptCase.genreWeights).length).toBeGreaterThan(0);
    }
  });

  it('hard-filters only the labelled soft case whose prompt names Comedy', () => {
    const filteredSoft = PROMPT_CASES.filter(
      (entry) => entry.group === 'soft' && entry.expectedFilters !== undefined,
    );

    expect(filteredSoft.map((entry) => entry.id)).toEqual(['soft-lighthearted-first-date']);
    expect(filteredSoft[0]?.expectedFilters).toEqual({ genres: ['Comedy'] });
  });

  it('splits mood-phrase cases into two tune and two holdout cases', () => {
    const moodCases = PROMPT_CASES.filter((entry) => entry.moodSplit !== undefined);

    expect(moodCases.map((entry) => `${entry.moodSplit ?? ''}:${entry.id}`).sort()).toEqual([
      'holdout:soft-cozy-rainy-night',
      'holdout:soft-lighthearted-first-date',
      'tune:edge-lighthearted-girlfriend',
      'tune:soft-feel-good-date',
    ]);

    for (const promptCase of moodCases) {
      expect(parsePromptMood(promptCase.prompt)).not.toBeNull();
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
