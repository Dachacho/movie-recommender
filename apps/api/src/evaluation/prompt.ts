import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { inArray, sql } from 'drizzle-orm';
import { createDatabase, type Database } from '../db/client.js';
import { movies } from '../db/schema.js';
import {
  createEmbedder,
  EMBEDDING_DTYPE,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  EMBEDDING_VERSION,
} from '../modules/movies/embed.js';
import {
  combineQueryVector,
  PROMPT_WEIGHT,
  TASTE_WEIGHT,
} from '../modules/recommendations/combine.js';
import { parsePromptConstraints } from '../modules/recommendations/constraints.js';
import {
  MOOD_BOOST_WEIGHT,
  MOOD_GENRE_AFFINITIES,
  MOOD_PHRASES,
  parsePromptMood,
  type MoodGenreWeights,
} from '../modules/recommendations/mood.js';
import { recommendMovies } from '../modules/recommendations/recommend.js';
import type { RecommendationFilters } from '../modules/recommendations/types.js';
import { computeTasteVector } from '../modules/taste/vector.js';
import { PROMPT_CASES, type PromptCase, type PromptCaseGroup } from './prompt-cases.js';
import {
  createSyntheticTasteVector,
  satisfiesFilters,
  scoreSelection,
  scoreSelections,
  SYNTHETIC_TASTE_SEED,
  type PickMetadata,
  type PromptSelection,
  type PromptWeightScore,
} from './prompt-metrics.js';

const OUTPUT_PATH = fileURLToPath(
  new URL('../../../../docs/evaluation-prompt-2026-11-26.md', import.meta.url),
);
const RECOMMENDATION_LIMIT = 4;
const MATERIAL_IMPROVEMENT = 0.02;
const MOOD_HOLDOUT_TOLERANCE = 0.01;
const GROUP_ORDER: readonly PromptCaseGroup[] = ['explicit', 'soft', 'edge', 'control'];
const BOOST_WEIGHTS: readonly number[] = [0, 0.1, 0.15, 0.18, 0.2, 0.25];
const REPORTED_MOOD_CASE_ID = 'edge-lighthearted-girlfriend';
const THRILLER_PERSONA_IDS = [274, 807, 1949, 146233, 210577, 242582, 273481] as const;
const WARM_MOOD_GENRES = ['Romance', 'Family', 'Animation'] as const;

type PersonaId = 'synthetic' | 'thriller';

interface Persona {
  id: PersonaId;
  label: string;
  tasteVector: readonly number[];
}

interface WeightPair {
  promptWeight: number;
  tasteWeight: number;
}

interface PickRecord extends PickMetadata {
  title: string;
}

const WEIGHT_PAIRS: readonly WeightPair[] = [
  { promptWeight: 0.35, tasteWeight: 0.65 },
  { promptWeight: 0.5, tasteWeight: 0.5 },
  { promptWeight: 0.65, tasteWeight: 0.35 },
  { promptWeight: 0.8, tasteWeight: 0.2 },
  { promptWeight: 1, tasteWeight: 0 },
];

interface InitialParserFailure {
  caseId: string;
  prompt: string;
}

/** The first red run against the pre-change parser, kept for auditability. */
const INITIAL_PARSER_FAILURES: readonly InitialParserFailure[] = [
  { caseId: 'explicit-runtime-range', prompt: 'between 2 and 3 hours' },
  { caseId: 'edge-rom-com-90s', prompt: 'a rom-com from the 90s' },
  { caseId: 'edge-romantic-comedy-80s', prompt: "a romantic comedy from the 80's" },
  { caseId: 'edge-crime-70s-range', prompt: 'a 70s crime film between 90 and 120 minutes' },
  { caseId: 'edge-comedy-or-less', prompt: 'a 90 minutes or less comedy' },
  { caseId: 'edge-thriller-no-longer', prompt: 'a no longer than 2 hours thriller' },
  { caseId: 'edge-scary-under-90', prompt: 'a scary movie under 90 minutes' },
  { caseId: 'edge-negated-horror', prompt: 'not a horror movie' },
];

const PARSER_RULES_ADDED: readonly string[] = [
  'rom-com/romcom => Comedy + Romance at the same mention index, ordered alphabetically on the tie.',
  'Apostrophe decades: "80\'s", "90\'s" and "1990\'s" alongside "\'90s".',
  'Runtime ranges: between/from X and/to Y with a unit, and X–Y minutes.',
  'Trailing runtime bounds: "X minutes or less/fewer" => runtimeMax, "or more" => runtimeMin.',
  '"no longer than" => runtimeMax.',
  '"scary"/"frightening" => Horror.',
  'Negated genre mentions suppress the positive match without adding an excludeGenres filter.',
];

interface FollowUpMiss {
  prompt: string;
  explanation: string;
}

const FOLLOW_UP_MISSES: readonly FollowUpMiss[] = [
  {
    prompt: 'lighthearted movie i can watch with my girlfriend',
    explanation:
      'This exact prompt previously parsed to no filters, so a thriller-leaning taste pulled thriller/crime/horror picks. Added "lighthearted", "light-hearted" and "light hearted" as Comedy synonyms in the existing Comedy pattern. "Girlfriend" remains date context only: no Romance hard filter, and Romance stays a 0.5 graded label for this case. The taste blend remains 0.50/0.50; the additive mood term is evaluated separately in the Mood affinity section.',
  },
];

interface ParseCheck {
  promptCase: PromptCase;
  index: number;
  parsed: RecommendationFilters | undefined;
  mood: MoodGenreWeights | null;
  matches: boolean;
}

interface WeightRun {
  promptWeight: number;
  tasteWeight: number;
  score: PromptWeightScore;
}

interface BoostRun {
  persona: Persona;
  boostWeight: number;
  score: PromptWeightScore;
  tuneGenrePrecision: number;
  holdoutGenrePrecision: number;
  nonMoodSoftGenrePrecision: number;
  reportedPicks: readonly PickRecord[];
  guardPassed: boolean;
}

interface MoodBoostDecision {
  chosenWeight: number;
  maximumHoldoutPrecision: number;
  guardPassingWeights: readonly number[];
}

interface CatalogStats {
  total: number;
  embedded: number;
}

interface ReportInput {
  catalog: CatalogStats;
  parseChecks: readonly ParseCheck[];
  weightRuns: readonly WeightRun[];
  moodRuns: readonly BoostRun[];
  decision: MoodBoostDecision;
}

function pairLabel(pair: WeightPair): string {
  return `${pair.promptWeight.toFixed(2)} / ${pair.tasteWeight.toFixed(2)}`;
}

function metric(value: number): string {
  return value.toFixed(4);
}

function percent(part: number, total: number): string {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function filtersText(filters: RecommendationFilters | undefined): string {
  return filters === undefined ? 'undefined' : JSON.stringify(filters);
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function weightCell(pair: WeightPair): string {
  return `${pair.promptWeight.toFixed(2)} / ${pair.tasteWeight.toFixed(2)}`;
}

async function loadPickMetadata(
  db: Database,
  movieIds: readonly number[],
): Promise<Map<number, PickRecord>> {
  const ids = [...new Set(movieIds)];
  const metadata = new Map<number, PickRecord>();

  if (ids.length === 0) {
    return metadata;
  }

  const rows = await db
    .select({
      movieId: movies.id,
      title: movies.title,
      releaseYear: movies.releaseYear,
      runtime: movies.runtime,
      genres: movies.genres,
      embedding: movies.embedding,
    })
    .from(movies)
    .where(inArray(movies.id, ids));

  for (const row of rows) {
    if (row.embedding === null) {
      throw new Error(
        `movieId ${String(row.movieId)} was recommended without an embedding; the production path should exclude it.`,
      );
    }

    metadata.set(row.movieId, {
      movieId: row.movieId,
      title: row.title,
      releaseYear: row.releaseYear,
      runtime: row.runtime,
      genres: row.genres,
      embedding: row.embedding,
    });
  }

  return metadata;
}

/**
 * Deterministic thriller taste from committed catalog ids at five stars. Rows
 * are sorted by movieId because float addition is not associative; embeddings
 * come from Postgres, never from a live API.
 */
async function loadThrillerTasteVector(db: Database): Promise<number[]> {
  const rows = await db
    .select({ movieId: movies.id, embedding: movies.embedding })
    .from(movies)
    .where(inArray(movies.id, [...THRILLER_PERSONA_IDS]));

  rows.sort((left, right) => left.movieId - right.movieId);

  if (rows.length !== THRILLER_PERSONA_IDS.length) {
    throw new Error(
      `Expected ${String(THRILLER_PERSONA_IDS.length)} thriller fixture rows, received ${String(
        rows.length,
      )}.`,
    );
  }

  const tasteVector = computeTasteVector(
    rows.map((row) => {
      if (row.embedding === null) {
        throw new Error(`Thriller fixture movieId ${String(row.movieId)} has no embedding.`);
      }

      return { movieId: row.movieId, rating: 5, embedding: row.embedding };
    }),
  );

  if (tasteVector === null) {
    throw new Error('The thriller fixture produced a zero-norm taste vector.');
  }

  return tasteVector;
}

function boostKey(personaId: PersonaId, boostWeight: number, caseId: string): string {
  return `${personaId}:${String(boostWeight)}:${caseId}`;
}

function pickRecordsFromIds(
  movieIds: readonly number[],
  metadata: ReadonlyMap<number, PickRecord>,
  caseId: string,
): PickRecord[] {
  return movieIds.map((movieId) => {
    const entry = metadata.get(movieId);

    if (entry === undefined) {
      throw new Error(
        `Missing metadata for recommended movieId ${String(movieId)} in case ${caseId}.`,
      );
    }

    return entry;
  });
}

function selectionsFromPickIds(
  checks: readonly ParseCheck[],
  pickIdsFor: (check: ParseCheck) => readonly number[],
  metadata: ReadonlyMap<number, PickRecord>,
): PromptSelection[] {
  return checks.map((check) => ({
    group: check.promptCase.group,
    expectedFilters: check.promptCase.expectedFilters,
    genreWeights: check.promptCase.genreWeights,
    picks: pickRecordsFromIds(pickIdsFor(check), metadata, check.promptCase.id),
  }));
}

function meanGenrePrecision(
  selections: readonly PromptSelection[],
  tasteVector: readonly number[],
): number {
  const precisions = selections
    .map((selection) => scoreSelection(selection, tasteVector).genrePrecision)
    .filter((value): value is number => value !== undefined);

  if (precisions.length === 0) {
    return 0;
  }

  return precisions.reduce((sum, value) => sum + value, 0) / precisions.length;
}

function meetsReportedMoodGuard(picks: readonly PickMetadata[]): boolean {
  if (picks.length !== RECOMMENDATION_LIMIT) {
    return false;
  }

  if (!picks.every((pick) => pick.genres.includes('Comedy'))) {
    return false;
  }

  const warmPicks = picks.filter((pick) =>
    pick.genres.some((genre) => WARM_MOOD_GENRES.some((warm) => warm === genre)),
  );
  const romancePicks = picks.filter((pick) => pick.genres.includes('Romance'));

  return warmPicks.length >= 3 && romancePicks.length >= 1;
}

/**
 * Guards report/route parity for the reported case. The harness embeds this
 * prompt alone, exactly as the route does; if it ever batches again, the vector
 * changes and the reported ids can silently disagree with production.
 */
function assertReportedPicks(
  picks: readonly PickMetadata[],
  parsedFilters: RecommendationFilters | undefined,
  caseId: string,
): void {
  if (picks.length !== RECOMMENDATION_LIMIT) {
    throw new Error(
      `The reported case ${caseId} returned ${String(picks.length)} picks; expected ${String(
        RECOMMENDATION_LIMIT,
      )}.`,
    );
  }

  if (parsedFilters === undefined) {
    throw new Error(`The reported case ${caseId} parsed to no hard filter.`);
  }

  for (const pick of picks) {
    if (!satisfiesFilters(pick, parsedFilters)) {
      throw new Error(
        `The reported case ${caseId} returned movieId ${String(
          pick.movieId,
        )} that violates the parsed hard filter ${JSON.stringify(parsedFilters)}.`,
      );
    }
  }
}

/**
 * Pre-declared selection rule. The reported thriller case must pass the
 * acceptance guard. From those weights, take the smallest whose holdout
 * precision is within MOOD_HOLDOUT_TOLERANCE of the maximum and whose tune,
 * non-mood, constraint and empty-result metrics do not fall below the no-boost
 * run. Runs are ordered by boost weight, so ties choose the smaller boost.
 */
function chooseMoodBoostWeight(runs: readonly BoostRun[]): MoodBoostDecision {
  const thrillerRuns = runs
    .filter((run) => run.persona.id === 'thriller')
    .sort((left, right) => left.boostWeight - right.boostWeight);

  if (thrillerRuns.length !== BOOST_WEIGHTS.length) {
    throw new Error('The mood sweep must contain one thriller run per boost weight.');
  }

  const baseline = thrillerRuns.find((run) => run.boostWeight === 0);

  if (baseline === undefined) {
    throw new Error('The mood sweep must include the no-boost baseline.');
  }

  const guardPassing = thrillerRuns.filter((run) => run.guardPassed);

  if (guardPassing.length === 0) {
    throw new Error('No boost weight passes the reported-case acceptance guard.');
  }

  // Only guard-passing weights are eligible, so their best holdout precision is
  // the target the rule compares against.
  const maximumHoldoutPrecision = Math.max(...guardPassing.map((run) => run.holdoutGenrePrecision));

  const chosen = guardPassing.find(
    (run) =>
      run.holdoutGenrePrecision + 1e-12 >= maximumHoldoutPrecision - MOOD_HOLDOUT_TOLERANCE &&
      run.tuneGenrePrecision + 1e-12 >= baseline.tuneGenrePrecision &&
      run.nonMoodSoftGenrePrecision + 1e-12 >= baseline.nonMoodSoftGenrePrecision &&
      run.score.constraintSatisfactionNonEmpty + 1e-12 >=
        baseline.score.constraintSatisfactionNonEmpty &&
      run.score.emptyResults <= baseline.score.emptyResults,
  );

  if (chosen === undefined) {
    throw new Error(
      `No boost weight passes the pre-declared mood selection rule. ${thrillerRuns
        .map(
          (run) =>
            `boost ${run.boostWeight.toFixed(2)}: guard=${
              run.guardPassed ? 'pass' : 'fail'
            } tune=${run.tuneGenrePrecision.toFixed(4)} holdout=${run.holdoutGenrePrecision.toFixed(
              4,
            )} nonMood=${run.nonMoodSoftGenrePrecision.toFixed(
              4,
            )} constraints=${run.score.constraintSatisfactionNonEmpty.toFixed(
              4,
            )} empty=${String(run.score.emptyResults)}`,
        )
        .join(
          '; ',
        )}; maxHoldout=${maximumHoldoutPrecision.toFixed(4)}; baseline tune=${baseline.tuneGenrePrecision.toFixed(
        4,
      )} nonMood=${baseline.nonMoodSoftGenrePrecision.toFixed(
        4,
      )} constraints=${baseline.score.constraintSatisfactionNonEmpty.toFixed(4)}.`,
    );
  }

  return {
    chosenWeight: chosen.boostWeight,
    maximumHoldoutPrecision,
    guardPassingWeights: guardPassing.map((run) => run.boostWeight),
  };
}

function affinityText(weights: MoodGenreWeights): string {
  return Object.entries(weights)
    .map(([genre, weight]) => `${genre} ${weight.toFixed(1)}`)
    .join(', ');
}

function compareRuns(left: WeightRun, right: WeightRun): number {
  const soft = right.score.genrePrecisionSoft - left.score.genrePrecisionSoft;

  if (Math.abs(soft) > 1e-12) {
    return soft;
  }

  const all = right.score.genrePrecisionAll - left.score.genrePrecisionAll;

  if (Math.abs(all) > 1e-12) {
    return all;
  }

  const constraints =
    right.score.constraintSatisfactionNonEmpty - left.score.constraintSatisfactionNonEmpty;

  if (Math.abs(constraints) > 1e-12) {
    return constraints;
  }

  return Math.abs(left.promptWeight - PROMPT_WEIGHT) - Math.abs(right.promptWeight - PROMPT_WEIGHT);
}

function recommendationText(weightRuns: readonly WeightRun[]): string {
  const baseline = weightRuns.find(
    (run) => run.promptWeight === PROMPT_WEIGHT && run.tasteWeight === TASTE_WEIGHT,
  );

  if (baseline === undefined) {
    throw new Error('The weight sweep must include the production 0.50 / 0.50 pair.');
  }

  const best = [...weightRuns].sort(compareRuns)[0];

  if (best === undefined) {
    throw new Error('The weight sweep must not be empty.');
  }

  const improvement = best.score.genrePrecisionSoft - baseline.score.genrePrecisionSoft;
  const sameAsBaseline =
    best.promptWeight === baseline.promptWeight && best.tasteWeight === baseline.tasteWeight;
  const constraintsHold =
    best.score.constraintSatisfactionNonEmpty + 1e-12 >=
    baseline.score.constraintSatisfactionNonEmpty;
  const emptiesHold = best.score.emptyResults <= baseline.score.emptyResults;
  const hardHolds =
    best.score.genrePrecisionHard + MATERIAL_IMPROVEMENT + 1e-12 >=
    baseline.score.genrePrecisionHard;

  if (
    !sameAsBaseline &&
    improvement >= MATERIAL_IMPROVEMENT &&
    constraintsHold &&
    emptiesHold &&
    hardHolds
  ) {
    return `Evidence supports moving toward ${pairLabel(best)}: soft genre precision is ${metric(
      best.score.genrePrecisionSoft,
    )} versus ${metric(
      baseline.score.genrePrecisionSoft,
    )} at ${pairLabel(baseline)}, with non-empty constraint satisfaction ${percent(
      best.score.constraintSatisfiedNonEmptyCases,
      best.score.constraintNonEmptyCases,
    )} and ${String(
      best.score.emptyResults,
    )} empty results. This step does not change production weights; the value is a follow-up candidate.`;
  }

  return `Keep ${pairLabel(
    baseline,
  )}. The best alternative (${pairLabel(best)}) changes soft genre precision by ${improvement >= 0 ? '+' : ''}${metric(
    improvement,
  )}, which does not clear the ${MATERIAL_IMPROVEMENT.toFixed(2)} materiality margin while holding the constraint, empty-result and hard-case guards.`;
}

function renderReport(input: ReportInput): string {
  const { catalog, parseChecks, weightRuns, moodRuns, decision } = input;
  const lines: string[] = [];
  const parsePassed = parseChecks.filter((check) => check.matches).length;
  const parseMisses = parseChecks.filter((check) => !check.matches);

  lines.push('# Prompt evaluation — labelled natural-language set');
  lines.push('');
  lines.push(
    `Offline harness output for \`npm run evaluate:prompt\`. It scores the committed parser and ordering path. The harness does not modify production weights (${String(
      PROMPT_WEIGHT,
    )}/${String(
      TASTE_WEIGHT,
    )}) or the shipped mood boost; parser coverage was widened in this step for the initial misses documented in the parser audit, and the mood boost was selected by the pre-declared held-out rule below.`,
  );
  lines.push('');
  lines.push('## Setup and provenance');
  lines.push('');
  lines.push(
    `- Catalog: ${count(catalog.total)} films in local Postgres, ${count(catalog.embedded)} with an embedding.`,
  );
  lines.push(
    `- Embedding model: \`${EMBEDDING_MODEL}\` revision \`${EMBEDDING_REVISION}\`, dtype \`${EMBEDDING_DTYPE}\`, mean pooling, normalized; embedding version \`${EMBEDDING_VERSION}\`.`,
  );
  lines.push(
    `- Synthetic taste vector: deterministic 384-d unit vector from mulberry32 seed \`0x${SYNTHETIC_TASTE_SEED.toString(
      16,
    )}\`. It is not a real user and no guest data is read.`,
  );
  lines.push(
    `- Thriller taste vector: deterministic persona from ${String(
      THRILLER_PERSONA_IDS.length,
    )} committed catalog ids (${THRILLER_PERSONA_IDS.join(', ')}) rated five stars. Embeddings are read from Postgres and summed after sorting rows by movieId; no live API is used.`,
  );
  lines.push(
    `- Retrieval: production \`recommendMovies\` path (top-500 cosine buffer, quality tilt, diversity rerank), limit ${String(
      RECOMMENDATION_LIMIT,
    )}, exploration 0, filters from \`parsePromptConstraints\` and mood affinities from \`parsePromptMood\` when the prompt contains a supported phrase.`,
  );
  lines.push(
    `- Prompt texts are embedded one at a time, matching the route's single-prompt request. Batch size changes the vector under this q8 model (cosine 0.9888 between a single embed and the same prompt in a 34-prompt batch, 0.9909 in a two-prompt batch, 1.0000 across repeated single embeds), so batching would make this report disagree with the served route. Weights are passed explicitly to \`combineQueryVector\`; production \`PROMPT_WEIGHT\`/\`TASTE_WEIGHT\` remain ${String(
      PROMPT_WEIGHT,
    )}/${String(TASTE_WEIGHT)}.`,
  );
  lines.push(
    `- Mood sweep: the production ${pairLabel({
      promptWeight: PROMPT_WEIGHT,
      tasteWeight: TASTE_WEIGHT,
    })} pairing for both personas at boost weights ${BOOST_WEIGHTS.map((weight) =>
      weight.toFixed(2),
    ).join(', ')}.`,
  );
  lines.push(
    '- The harness only reads the catalog and embeddings (no writes, no whole-profile load, no server).',
  );
  lines.push('');
  lines.push('## Dataset');
  lines.push('');
  lines.push(
    'Hand-labelled prompts. Expected filters are exactly what the existing filter schema can express; genre weights are graded relevance for what the prompt semantically asks for.',
  );
  lines.push('');
  lines.push('| Group | Cases | With expected filters | With genre weights |');
  lines.push('| --- | --- | --- | --- |');

  for (const group of GROUP_ORDER) {
    const groupCases = PROMPT_CASES.filter((promptCase) => promptCase.group === group);
    const withFilters = groupCases.filter(
      (promptCase) => promptCase.expectedFilters !== undefined,
    ).length;
    const withWeights = groupCases.filter(
      (promptCase) => Object.keys(promptCase.genreWeights).length > 0,
    ).length;

    lines.push(
      `| ${group} | ${String(groupCases.length)} | ${String(withFilters)} | ${String(withWeights)} |`,
    );
  }

  const withFilters = PROMPT_CASES.filter(
    (promptCase) => promptCase.expectedFilters !== undefined,
  ).length;
  const withWeights = PROMPT_CASES.filter(
    (promptCase) => Object.keys(promptCase.genreWeights).length > 0,
  ).length;

  const tuneCases = PROMPT_CASES.filter((promptCase) => promptCase.moodSplit === 'tune').length;
  const holdoutCases = PROMPT_CASES.filter(
    (promptCase) => promptCase.moodSplit === 'holdout',
  ).length;

  lines.push(
    `| **total** | **${String(PROMPT_CASES.length)}** | **${String(withFilters)}** | **${String(withWeights)}** |`,
  );
  lines.push('');
  lines.push(
    `Mood split: ${String(tuneCases)} tune cases and ${String(holdoutCases)} holdout cases. Tune cases inform the weight; holdout cases only validate it.`,
  );
  lines.push('');
  lines.push('## Parser audit');
  lines.push('');
  lines.push(
    'The first run of the original 28-case set against the pre-change parser failed 8 cases. These are kept here as the audit trail for the widening work:',
  );
  lines.push('');
  lines.push('| Case | Prompt |');
  lines.push('| --- | --- |');

  for (const failure of INITIAL_PARSER_FAILURES) {
    lines.push(`| ${failure.caseId} | ${markdownCell(failure.prompt)} |`);
  }

  lines.push('');
  lines.push('Rules added for those misses:');
  lines.push('');

  for (const rule of PARSER_RULES_ADDED) {
    lines.push(`- ${rule}`);
  }

  lines.push('');

  for (const miss of FOLLOW_UP_MISSES) {
    lines.push(`**Follow-up user-reported miss:** \`${miss.prompt}\``);
    lines.push('');
    lines.push(miss.explanation);
    lines.push('');
  }

  lines.push(
    'Follow-up hardening: "not only" is treated as inclusion; contractions (don\'t/dont, didn\'t, doesn\'t, wouldn\'t, won\'t) and "anything but"/"all but" are treated as negation; and range, directional and trailing runtime bounds now compete by mention index, with the existing first-bound-wins rule resolving contradictions.',
  );
  lines.push('');
  lines.push(
    'Production retrieval still uses parser output, so these fixes directly change which filters are sent for the affected prompts.',
  );
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push(
    '- `parseAccuracy`: exact deep equality between `parsePromptConstraints` and the labelled `expectedFilters` for every case.',
  );
  lines.push(
    '- `constraintSatisfaction`: fraction of cases with expected filters whose every returned pick satisfies genre OR, year bounds and runtime bounds. An empty result is vacuously true; the non-empty variant is reported beside it.',
  );
  lines.push(
    `- \`genrePrecision@${String(
      RECOMMENDATION_LIMIT,
    )}\`: per pick, the maximum weight among its genres (0 when none match); per case, the mean over returned picks (0 for an empty result); then the mean over cases. Reported for all labelled cases, hard-filter cases and soft cases separately.`,
  );
  lines.push(
    `- \`tasteSimilarity@${String(
      RECOMMENDATION_LIMIT,
    )}\`: mean cosine between returned picks and the run's persona taste vector, over cases that returned picks. Diagnostic only.`,
  );
  lines.push(
    '- `tuneMoodPrecision@4` and `holdoutMoodPrecision@4`: mean graded genre precision over the mood cases in each split, regardless of case group.',
  );
  lines.push(
    '- `nonMoodSoftPrecision@4`: mean graded genre precision over soft cases whose prompt contains no mood phrase. It must be identical across boost weights because the term is absent for those prompts.',
  );
  lines.push(
    '- Empty-result counts are reported per weight pair because filtering can exhaust a pool.',
  );
  lines.push('');
  lines.push('## Parse coverage');
  lines.push('');
  lines.push(
    `Parse accuracy: ${String(parsePassed)}/${String(parseChecks.length)} (${percent(
      parsePassed,
      parseChecks.length,
    )}).`,
  );
  lines.push('');

  if (parseMisses.length > 0) {
    lines.push('| Group | Case | Prompt | Expected | Parsed |');
    lines.push('| --- | --- | --- | --- | --- |');

    for (const miss of parseMisses) {
      lines.push(
        `| ${miss.promptCase.group} | ${miss.promptCase.id} | ${markdownCell(
          miss.promptCase.prompt,
        )} | ${markdownCell(filtersText(miss.promptCase.expectedFilters))} | ${markdownCell(
          filtersText(miss.parsed),
        )} |`,
      );
    }

    lines.push('');
  } else {
    lines.push('No parse misses.');
    lines.push('');
  }

  lines.push('## Weight sweep');
  lines.push('');
  lines.push(
    'All five weight pairs use the same prompts, single-prompt embeddings and synthetic taste vector. Only the combination weights change. Mood prompts also receive the shipped additive mood term.',
  );
  lines.push('');
  lines.push(
    `| Prompt / taste | Constraint satisfaction | Non-empty satisfaction | Empty results | Genre precision@${String(
      RECOMMENDATION_LIMIT,
    )} all | Hard | Soft | Taste similarity |`,
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const run of weightRuns) {
    const score = run.score;

    lines.push(
      `| ${weightCell(run)} | ${String(score.constraintSatisfiedCases)}/${String(
        score.constraintCases,
      )} (${percent(score.constraintSatisfiedCases, score.constraintCases)}) | ${String(
        score.constraintSatisfiedNonEmptyCases,
      )}/${String(score.constraintNonEmptyCases)} | ${String(score.emptyResults)} | ${metric(
        score.genrePrecisionAll,
      )} | ${metric(score.genrePrecisionHard)} | ${metric(score.genrePrecisionSoft)} | ${metric(
        score.tasteSimilarity,
      )} |`,
    );
  }

  lines.push('');
  lines.push('## Mood affinity');
  lines.push('');
  lines.push(
    'The additive mood term applies only when the prompt contains one of the supported phrases. Per film it adds the strongest matching genre affinity multiplied by the boost weight, capped at that weight; it never filters, so it only tilts the pool ordering and the diversity rerank.',
  );
  lines.push('');
  lines.push('### Phrase table');
  lines.push('');
  lines.push('| Phrase | Genre affinities (max per genre) |');
  lines.push('| --- | --- |');

  for (const phrase of MOOD_PHRASES) {
    lines.push(`| \`${phrase}\` | ${affinityText(MOOD_GENRE_AFFINITIES)} |`);
  }

  lines.push('');
  lines.push('### Boost sweep');
  lines.push('');
  lines.push(
    `Production ${pairLabel({
      promptWeight: PROMPT_WEIGHT,
      tasteWeight: TASTE_WEIGHT,
    })} pairing; the reported case is \`${REPORTED_MOOD_CASE_ID}\`. The guard is defined for the thriller persona only.`,
  );
  lines.push('');
  lines.push(
    `| Persona | Boost | Reported guard | Tune mood precision@${String(
      RECOMMENDATION_LIMIT,
    )} | Holdout mood precision@${String(RECOMMENDATION_LIMIT)} | Non-mood soft precision@${String(
      RECOMMENDATION_LIMIT,
    )} | Non-empty constraints | Empty results | Taste similarity |`,
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const run of moodRuns) {
    const guard =
      run.persona.id === 'thriller' ? (run.guardPassed ? 'pass' : 'fail') : 'not applicable';

    lines.push(
      `| ${run.persona.label} | ${run.boostWeight.toFixed(2)} | ${guard} | ${metric(
        run.tuneGenrePrecision,
      )} | ${metric(run.holdoutGenrePrecision)} | ${metric(
        run.nonMoodSoftGenrePrecision,
      )} | ${String(run.score.constraintSatisfiedNonEmptyCases)}/${String(
        run.score.constraintNonEmptyCases,
      )} | ${String(run.score.emptyResults)} | ${metric(run.score.tasteSimilarity)} |`,
    );
  }

  lines.push('');
  lines.push('### Selection rule and chosen weight');
  lines.push('');
  lines.push(
    `1. Acceptance guard: with the thriller persona and \`${REPORTED_MOOD_CASE_ID}\`, all ${String(
      RECOMMENDATION_LIMIT,
    )} picks are Comedy and at least 3 carry Romance, Family or Animation with at least one Romance.`,
  );
  lines.push(
    `2. Among weights that pass the guard, choose the smallest boost whose holdout mood precision is within ${MOOD_HOLDOUT_TOLERANCE.toFixed(
      2,
    )} of the maximum holdout precision in that guard-passing set and that does not reduce tune precision, non-mood soft precision or non-empty constraint satisfaction versus the no-boost baseline, or increase empty results.`,
  );
  lines.push('3. Ties choose the smaller boost, because less taste override is preferred.');
  lines.push('');
  lines.push(
    'The rule evaluates the thriller persona, the persona named by the acceptance guard; the synthetic persona is reported for comparison only.',
  );
  lines.push('');
  lines.push(
    `Guard-passing weights: ${decision.guardPassingWeights.length === 0 ? 'none' : decision.guardPassingWeights.map((weight) => weight.toFixed(2)).join(', ')}. Maximum holdout mood precision among them: ${metric(
      decision.maximumHoldoutPrecision,
    )}.`,
  );
  lines.push('');
  lines.push(
    `Chosen boost: **${decision.chosenWeight.toFixed(2)}**. Shipped \`MOOD_BOOST_WEIGHT\`: ${MOOD_BOOST_WEIGHT.toFixed(
      2,
    )}${
      Math.abs(decision.chosenWeight - MOOD_BOOST_WEIGHT) <= 1e-12
        ? ' (matches).'
        : ' (**mismatch: update the constant**).'
    }`,
  );

  const reportedRun = moodRuns.find(
    (run) => run.persona.id === 'thriller' && run.boostWeight === decision.chosenWeight,
  );

  if (reportedRun === undefined) {
    throw new Error('The chosen boost is missing from the thriller sweep.');
  }

  const warmPicks = reportedRun.reportedPicks.filter((pick) =>
    pick.genres.some((genre) => WARM_MOOD_GENRES.some((warm) => warm === genre)),
  );
  const romancePicks = reportedRun.reportedPicks.filter((pick) => pick.genres.includes('Romance'));

  lines.push('');
  lines.push('### Reported case at the chosen weight');
  lines.push('');
  lines.push(
    `Thriller persona, \`${REPORTED_MOOD_CASE_ID}\`, boost ${decision.chosenWeight.toFixed(2)}:`,
  );
  lines.push('');
  lines.push('| Rank | movieId | Title | Genres |');
  lines.push('| --- | --- | --- | --- |');

  reportedRun.reportedPicks.forEach((pick, index) => {
    lines.push(
      `| ${String(index + 1)} | ${String(pick.movieId)} | ${markdownCell(
        pick.title,
      )} | ${markdownCell(pick.genres.join(', '))} |`,
    );
  });

  lines.push('');
  lines.push(
    `Reported ids: ${reportedRun.reportedPicks.map((pick) => String(pick.movieId)).join(', ')}.`,
  );
  lines.push('');
  lines.push(
    `Result: ${String(warmPicks.length)}/${String(
      reportedRun.reportedPicks.length,
    )} carry a warm genre, ${String(romancePicks.length)} carry Romance; guard ${
      reportedRun.guardPassed ? 'passes' : 'fails'
    }.`,
  );
  lines.push('');
  lines.push(
    'The harness embeds this prompt one at a time, exactly as the route does. The DB regression in `prompt-filter.test.ts` follows the same single-prompt path against the current catalog snapshot and pins these ids and their order.',
  );
  lines.push('');
  lines.push('### No-mood guard');
  lines.push('');

  const personas = new Map(moodRuns.map((run) => [run.persona.id, run.persona]));

  for (const persona of personas.values()) {
    const values = moodRuns
      .filter((run) => run.persona.id === persona.id)
      .map((run) => run.nonMoodSoftGenrePrecision);
    const min = Math.min(...values);
    const max = Math.max(...values);

    lines.push(
      `- ${persona.label}: non-mood soft precision is ${metric(min)}–${metric(
        max,
      )} across boost weights${
        Math.abs(max - min) <= 1e-12 ? ' (unchanged, as required)' : ' (**changed: investigate**)'
      }.`,
    );
  }

  lines.push('');
  lines.push('## Findings');
  lines.push('');
  lines.push(
    `- Parser: ${String(parsePassed)}/${String(parseChecks.length)} cases match exactly (${percent(
      parsePassed,
      parseChecks.length,
    )}).`,
  );

  const constraintMin = Math.min(
    ...weightRuns.map((run) => run.score.constraintSatisfactionNonEmpty),
  );
  const constraintMax = Math.max(
    ...weightRuns.map((run) => run.score.constraintSatisfactionNonEmpty),
  );
  const emptyMin = Math.min(...weightRuns.map((run) => run.score.emptyResults));
  const emptyMax = Math.max(...weightRuns.map((run) => run.score.emptyResults));
  const softMin = Math.min(...weightRuns.map((run) => run.score.genrePrecisionSoft));
  const softMax = Math.max(...weightRuns.map((run) => run.score.genrePrecisionSoft));
  const hardMin = Math.min(...weightRuns.map((run) => run.score.genrePrecisionHard));
  const hardMax = Math.max(...weightRuns.map((run) => run.score.genrePrecisionHard));
  const tasteMin = Math.min(...weightRuns.map((run) => run.score.tasteSimilarity));
  const tasteMax = Math.max(...weightRuns.map((run) => run.score.tasteSimilarity));

  lines.push(
    `- Constraint satisfaction across non-empty filtered cases ranges ${metric(
      constraintMin,
    )}–${metric(constraintMax)}; empty results range ${String(emptyMin)}–${String(
      emptyMax,
    )} per weight pair.`,
  );
  lines.push(
    `- Genre precision@${String(
      RECOMMENDATION_LIMIT,
    )}: hard-filter cases ${metric(hardMin)}–${metric(hardMax)}, soft cases ${metric(
      softMin,
    )}–${metric(softMax)}.`,
  );
  lines.push(
    `- Taste similarity (diagnostic) ranges ${metric(tasteMin)}–${metric(tasteMax)} against the fixed synthetic persona.`,
  );
  lines.push(
    `- Mood: the pre-declared rule selects ${decision.chosenWeight.toFixed(
      2,
    )}; the reported thriller case passes the guard at that weight, and non-mood soft cases are unchanged across the sweep.`,
  );
  lines.push('');
  lines.push('### Recommendation');
  lines.push('');
  lines.push(
    `Decision rule: propose a change only when a pair beats ${pairLabel({
      promptWeight: PROMPT_WEIGHT,
      tasteWeight: TASTE_WEIGHT,
    })} in soft genre precision by at least ${MATERIAL_IMPROVEMENT.toFixed(
      2,
    )}, does not reduce non-empty constraint satisfaction, does not increase empty results, and loses no more than ${MATERIAL_IMPROVEMENT.toFixed(
      2,
    )} hard-case genre precision.`,
  );
  lines.push('');
  lines.push(recommendationText(weightRuns));
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push(
    `- The set is small (${String(
      PROMPT_CASES.length,
    )} hand-labelled prompts) and the genre labels are an authored interpretation, not an objective ground truth.`,
  );
  lines.push(
    '- The synthetic and thriller taste vectors are fixed deterministic personas, not real users; taste similarity is a diagnostic, not evidence about personalization.',
  );
  lines.push(
    '- Mood labels are authored and only two holdout mood cases exist. The chosen weight is evidence-backed on that small sample and must be retuned when more holdout cases are added.',
  );
  lines.push(
    '- One deterministic run, no confidence intervals or significance test. Differences below the 0.02 materiality margin are treated as noise.',
  );
  lines.push(
    '- Hard-filter cases are partly guaranteed by the filter itself; their genre precision checks the filter/rank interaction, not semantic understanding.',
  );
  lines.push('- Controls have no genre labels; they exercise the taste/ordering path only.');
  lines.push(
    '- The catalog is the local 2026 snapshot and the embedding model is pinned; another snapshot can change which films compete for four slots.',
  );
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const { db, pool } = createDatabase();

  try {
    const [catalogRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        embedded: sql<number>`count(${movies.embedding})::int`,
      })
      .from(movies);

    if (catalogRow === undefined) {
      throw new Error('The catalog is empty.');
    }

    const parseChecks: ParseCheck[] = PROMPT_CASES.map((promptCase, index) => {
      const parsed = parsePromptConstraints(promptCase.prompt);

      return {
        promptCase,
        index,
        parsed,
        mood: parsePromptMood(promptCase.prompt),
        matches: isDeepStrictEqual(parsed, promptCase.expectedFilters),
      };
    });

    const embedder = await createEmbedder();
    const promptVectors: number[][] = [];

    // Production embeds one prompt per request (`routes.ts`), and batch size
    // changes the vector under this q8 model, so a batched harness would rank a
    // different pool and disagree with the served route.
    for (const promptCase of PROMPT_CASES) {
      const [promptVector] = await embedder([promptCase.prompt]);

      if (promptVector === undefined) {
        throw new Error(`Missing embedding for prompt case ${promptCase.id}.`);
      }

      promptVectors.push(promptVector);
    }

    const syntheticTasteVector = createSyntheticTasteVector();
    const personas: readonly Persona[] = [
      {
        id: 'synthetic',
        label: 'Synthetic seed',
        tasteVector: syntheticTasteVector,
      },
      {
        id: 'thriller',
        label: 'Thriller fixture',
        tasteVector: await loadThrillerTasteVector(db),
      },
    ];

    const picksByRun = new Map<string, number[]>();
    const runCount = WEIGHT_PAIRS.length * PROMPT_CASES.length;
    let completed = 0;

    for (const pair of WEIGHT_PAIRS) {
      console.error(`Evaluating prompt/taste ${pairLabel(pair)}`);

      for (const check of parseChecks) {
        const promptVector = promptVectors[check.index];

        if (promptVector === undefined) {
          throw new Error(`Missing embedding for prompt case ${check.promptCase.id}.`);
        }

        const queryVector = combineQueryVector({
          promptVector,
          tasteVector: syntheticTasteVector,
          promptWeight: pair.promptWeight,
          tasteWeight: pair.tasteWeight,
        });

        if (queryVector === null) {
          throw new Error(`No query vector for prompt case ${check.promptCase.id}.`);
        }

        const result = await recommendMovies(db, {
          tasteVector: queryVector,
          ...(check.parsed === undefined ? {} : { filters: check.parsed }),
          ...(check.mood === null ? {} : { mood: check.mood }),
          limit: RECOMMENDATION_LIMIT,
        });

        picksByRun.set(
          `${String(pair.promptWeight)}:${String(pair.tasteWeight)}:${check.promptCase.id}`,
          result.movieIds,
        );
        completed += 1;

        if (completed % 20 === 0) {
          console.error(`Evaluated ${String(completed)} / ${String(runCount)} runs`);
        }
      }
    }

    const boostPicks = new Map<string, number[]>();
    const boostRunCount = personas.length * BOOST_WEIGHTS.length * parseChecks.length;
    let completedBoostRuns = 0;

    for (const persona of personas) {
      for (const boostWeight of BOOST_WEIGHTS) {
        console.error(`Evaluating mood boost ${boostWeight.toFixed(2)} for ${persona.label}`);

        for (const check of parseChecks) {
          const promptVector = promptVectors[check.index];

          if (promptVector === undefined) {
            throw new Error(`Missing embedding for prompt case ${check.promptCase.id}.`);
          }

          const queryVector = combineQueryVector({
            promptVector,
            tasteVector: persona.tasteVector,
            promptWeight: PROMPT_WEIGHT,
            tasteWeight: TASTE_WEIGHT,
          });

          if (queryVector === null) {
            throw new Error(`No query vector for prompt case ${check.promptCase.id}.`);
          }

          const result = await recommendMovies(db, {
            tasteVector: queryVector,
            ...(check.parsed === undefined ? {} : { filters: check.parsed }),
            ...(check.mood === null ? {} : { mood: check.mood }),
            moodBoostWeight: boostWeight,
            limit: RECOMMENDATION_LIMIT,
          });

          boostPicks.set(boostKey(persona.id, boostWeight, check.promptCase.id), result.movieIds);
          completedBoostRuns += 1;
        }
      }

      console.error(`Evaluated ${String(completedBoostRuns)} / ${String(boostRunCount)} mood runs`);
    }

    const allPickIds = [...picksByRun.values(), ...boostPicks.values()].flat();
    const metadata = await loadPickMetadata(db, allPickIds);
    const weightRuns: WeightRun[] = WEIGHT_PAIRS.map((pair) => {
      const selections = selectionsFromPickIds(
        parseChecks,
        (check) =>
          picksByRun.get(
            `${String(pair.promptWeight)}:${String(pair.tasteWeight)}:${check.promptCase.id}`,
          ) ?? [],
        metadata,
      );

      return {
        promptWeight: pair.promptWeight,
        tasteWeight: pair.tasteWeight,
        score: scoreSelections(selections, syntheticTasteVector),
      };
    });

    const moodRuns: BoostRun[] = [];

    for (const persona of personas) {
      for (const boostWeight of BOOST_WEIGHTS) {
        const selections = selectionsFromPickIds(
          parseChecks,
          (check) => boostPicks.get(boostKey(persona.id, boostWeight, check.promptCase.id)) ?? [],
          metadata,
        );
        const tuneSelections = selections.filter(
          (_selection, index) => parseChecks[index]?.promptCase.moodSplit === 'tune',
        );
        const holdoutSelections = selections.filter(
          (_selection, index) => parseChecks[index]?.promptCase.moodSplit === 'holdout',
        );
        const nonMoodSoftSelections = selections.filter((selection, index) => {
          const check = parseChecks[index];

          return check !== undefined && selection.group === 'soft' && check.mood === null;
        });
        const reportedCheck = parseChecks.find(
          (check) => check.promptCase.id === REPORTED_MOOD_CASE_ID,
        );

        if (reportedCheck === undefined) {
          throw new Error(`Missing the reported mood case ${REPORTED_MOOD_CASE_ID}.`);
        }

        const reportedPicks = pickRecordsFromIds(
          boostPicks.get(boostKey(persona.id, boostWeight, REPORTED_MOOD_CASE_ID)) ?? [],
          metadata,
          REPORTED_MOOD_CASE_ID,
        );

        moodRuns.push({
          persona,
          boostWeight,
          score: scoreSelections(selections, persona.tasteVector),
          tuneGenrePrecision: meanGenrePrecision(tuneSelections, persona.tasteVector),
          holdoutGenrePrecision: meanGenrePrecision(holdoutSelections, persona.tasteVector),
          nonMoodSoftGenrePrecision: meanGenrePrecision(nonMoodSoftSelections, persona.tasteVector),
          reportedPicks,
          guardPassed: meetsReportedMoodGuard(reportedPicks),
        });
      }
    }

    const decision = chooseMoodBoostWeight(moodRuns);

    const reportedCheck = parseChecks.find(
      (check) => check.promptCase.id === REPORTED_MOOD_CASE_ID,
    );
    const reportedRun = moodRuns.find(
      (run) => run.persona.id === 'thriller' && run.boostWeight === decision.chosenWeight,
    );

    if (reportedCheck === undefined || reportedRun === undefined) {
      throw new Error(
        `Missing the reported mood case ${REPORTED_MOOD_CASE_ID} at the chosen weight.`,
      );
    }

    assertReportedPicks(reportedRun.reportedPicks, reportedCheck.parsed, REPORTED_MOOD_CASE_ID);

    if (Math.abs(decision.chosenWeight - MOOD_BOOST_WEIGHT) > 1e-12) {
      console.error(
        `The pre-declared rule selects ${decision.chosenWeight.toFixed(2)}, but MOOD_BOOST_WEIGHT is ${MOOD_BOOST_WEIGHT.toFixed(
          2,
        )}. Update the constant in mood.ts.`,
      );
      process.exitCode = 1;
    }

    const report = renderReport({
      catalog: { total: catalogRow.total, embedded: catalogRow.embedded },
      parseChecks,
      weightRuns,
      moodRuns,
      decision,
    });

    console.log(report);
    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${report}\n`, 'utf8');
    console.error(`Wrote ${OUTPUT_PATH}`);
  } finally {
    await pool.end();
  }
}

await main();
