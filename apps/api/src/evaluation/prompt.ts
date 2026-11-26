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
import { recommendMovies } from '../modules/recommendations/recommend.js';
import type { RecommendationFilters } from '../modules/recommendations/types.js';
import { PROMPT_CASES, type PromptCase, type PromptCaseGroup } from './prompt-cases.js';
import {
  createSyntheticTasteVector,
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
const GROUP_ORDER: readonly PromptCaseGroup[] = ['explicit', 'soft', 'edge', 'control'];

interface WeightPair {
  promptWeight: number;
  tasteWeight: number;
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

interface ParseCheck {
  promptCase: PromptCase;
  index: number;
  parsed: RecommendationFilters | undefined;
  matches: boolean;
}

interface WeightRun {
  promptWeight: number;
  tasteWeight: number;
  score: PromptWeightScore;
}

interface CatalogStats {
  total: number;
  embedded: number;
}

interface ReportInput {
  catalog: CatalogStats;
  parseChecks: readonly ParseCheck[];
  weightRuns: readonly WeightRun[];
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
): Promise<Map<number, PickMetadata>> {
  const ids = [...new Set(movieIds)];
  const metadata = new Map<number, PickMetadata>();

  if (ids.length === 0) {
    return metadata;
  }

  const rows = await db
    .select({
      movieId: movies.id,
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
      releaseYear: row.releaseYear,
      runtime: row.runtime,
      genres: row.genres,
      embedding: row.embedding,
    });
  }

  return metadata;
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
  const { catalog, parseChecks, weightRuns } = input;
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
    )}); parser coverage was widened in this step for the initial misses documented in the parser audit.`,
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
    `- Retrieval: production \`recommendMovies\` path (top-500 cosine buffer, quality tilt, diversity rerank), limit ${String(
      RECOMMENDATION_LIMIT,
    )}, exploration 0, filters from \`parsePromptConstraints\`.`,
  );
  lines.push(
    `- Prompt texts are embedded in one batch. Weights are passed explicitly to \`combineQueryVector\`; production \`PROMPT_WEIGHT\`/\`TASTE_WEIGHT\` remain ${String(
      PROMPT_WEIGHT,
    )}/${String(TASTE_WEIGHT)}.`,
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

  lines.push(
    `| **total** | **${String(PROMPT_CASES.length)}** | **${String(withFilters)}** | **${String(withWeights)}** |`,
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
    )}\`: mean cosine between returned picks and the fixed synthetic taste vector, over cases that returned picks. Diagnostic only.`,
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
    'All five weight pairs use the same prompts, batch embeddings and synthetic taste vector. Only the combination weights change.',
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
    '- The synthetic taste vector is a fixed deterministic direction, not a real user; taste similarity is a diagnostic, not evidence about personalization.',
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
  lines.push(
    '- No soft mood boost was added. Soft prompts are measured through semantic embedding similarity only.',
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
        matches: isDeepStrictEqual(parsed, promptCase.expectedFilters),
      };
    });

    const embedder = await createEmbedder();
    const promptVectors = await embedder(PROMPT_CASES.map((promptCase) => promptCase.prompt));

    if (promptVectors.length !== PROMPT_CASES.length) {
      throw new Error(
        `Expected ${String(PROMPT_CASES.length)} prompt embeddings, received ${String(
          promptVectors.length,
        )}.`,
      );
    }

    const tasteVector = createSyntheticTasteVector();
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
          tasteVector,
          promptWeight: pair.promptWeight,
          tasteWeight: pair.tasteWeight,
        });

        if (queryVector === null) {
          throw new Error(`No query vector for prompt case ${check.promptCase.id}.`);
        }

        const result = await recommendMovies(db, {
          tasteVector: queryVector,
          ...(check.parsed === undefined ? {} : { filters: check.parsed }),
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

    const allPickIds = [...picksByRun.values()].flat();
    const metadata = await loadPickMetadata(db, allPickIds);
    const weightRuns: WeightRun[] = WEIGHT_PAIRS.map((pair) => {
      const selections: PromptSelection[] = PROMPT_CASES.map((promptCase) => {
        const pickIds =
          picksByRun.get(
            `${String(pair.promptWeight)}:${String(pair.tasteWeight)}:${promptCase.id}`,
          ) ?? [];
        const picks = pickIds.map((movieId) => {
          const entry = metadata.get(movieId);

          if (entry === undefined) {
            throw new Error(
              `Missing metadata for recommended movieId ${String(movieId)} in case ${promptCase.id}.`,
            );
          }

          return entry;
        });

        return {
          group: promptCase.group,
          expectedFilters: promptCase.expectedFilters,
          genreWeights: promptCase.genreWeights,
          picks,
        };
      });

      return {
        promptWeight: pair.promptWeight,
        tasteWeight: pair.tasteWeight,
        score: scoreSelections(selections, tasteVector),
      };
    });

    const report = renderReport({
      catalog: { total: catalogRow.total, embedded: catalogRow.embedded },
      parseChecks,
      weightRuns,
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
