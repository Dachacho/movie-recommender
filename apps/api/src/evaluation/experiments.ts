import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDatabase } from '../db/client.js';
import { CANDIDATE_POOL_SIZE } from '../modules/recommendations/types.js';
import {
  DEFAULT_DIVERSITY_PENALTY,
  MAX_RECOMMENDATIONS,
  QUALITY_TILT_WEIGHT,
} from '../modules/recommendations/select.js';
import {
  loadCatalogUniverse,
  loadEvaluationData,
  loadMovieEmbeddings,
  type CatalogEntry,
  type CoverageStats,
} from './load.js';
import {
  LIKE_THRESHOLD,
  METRICS_DEPTH,
  evaluateRanking,
  likedIds,
  meanMetrics,
  type RankingMetrics,
} from './metrics.js';
import {
  EVALUATION_CANDIDATES,
  EVALUATION_MAX_POOL,
  fetchNearestPool,
  rankByGenre,
  rankByPopularity,
  rankCandidates,
  topLikedGenres,
  type RankingSettings,
  type RerankScoring,
} from './rank.js';
import { MIN_USER_RATINGS, TEST_FRACTION, splitRatings, type SplitStats } from './split.js';
import { buildTasteVector } from './taste.js';

interface ExperimentConfig {
  key: string;
  label: string;
  settings: RankingSettings;
}

interface Table {
  title: string;
  blurb: string;
  rows: { label: string; metrics: RankingMetrics; detail?: string }[];
}

const QUALITY_TILT = QUALITY_TILT_WEIGHT;
const RANKING_DEPTH = 100;

function settings(
  poolSize: number,
  poolTiltWeight: number,
  tiltWeight: number,
  scoring?: RerankScoring,
): RankingSettings {
  return {
    poolSize,
    poolTiltWeight,
    tiltWeight,
    depth: RANKING_DEPTH,
    ...(scoring === undefined ? {} : { scoring }),
  };
}

const CONFIGS: readonly ExperimentConfig[] = [
  {
    key: 'pool-100',
    label: 'Pool 100 — baseline parity',
    settings: settings(EVALUATION_CANDIDATES, 0, QUALITY_TILT),
  },
  {
    key: 'pool-50',
    label: 'Pool 50 (production pool)',
    settings: settings(CANDIDATE_POOL_SIZE, 0, QUALITY_TILT),
  },
  {
    key: 'pool-200',
    label: 'Pool 200',
    settings: settings(200, 0, QUALITY_TILT),
  },
  {
    key: 'pool-500',
    label: 'Pool 500',
    settings: settings(EVALUATION_MAX_POOL, 0, QUALITY_TILT),
  },
  {
    key: 'pool-50-tilt-add',
    label: 'Pool 50 — tilt at pool + rerank',
    settings: settings(CANDIDATE_POOL_SIZE, QUALITY_TILT, QUALITY_TILT),
  },
  {
    key: 'pool-200-tilt-add',
    label: 'Pool 200 — tilt at pool + rerank',
    settings: settings(200, QUALITY_TILT, QUALITY_TILT),
  },
  {
    key: 'pool-50-tilt-move',
    label: 'Pool 50 — tilt at pool only',
    settings: settings(CANDIDATE_POOL_SIZE, QUALITY_TILT, 0),
  },
  {
    key: 'pool-200-tilt-move',
    label: 'Pool 200 — tilt at pool only',
    settings: settings(200, QUALITY_TILT, 0),
  },
  {
    key: 'pool-100-t005',
    label: 'Pool 100 — tilt 0.05',
    settings: settings(EVALUATION_CANDIDATES, 0, 0.05),
  },
  {
    key: 'pool-100-t025',
    label: 'Pool 100 — tilt 0.25',
    settings: settings(EVALUATION_CANDIDATES, 0, 0.25),
  },
  {
    key: 'pool-100-t050',
    label: 'Pool 100 — tilt 0.50',
    settings: settings(EVALUATION_CANDIDATES, 0, 0.5),
  },
  {
    key: 'pool-50-t005',
    label: 'Pool 50 — tilt 0.05',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0.05),
  },
  {
    key: 'pool-50-t025',
    label: 'Pool 50 — tilt 0.25',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0.25),
  },
  {
    key: 'pool-50-t050',
    label: 'Pool 50 — tilt 0.50',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0.5),
  },
  {
    key: 'rerank-zscore-p50-w03',
    label: 'Pool 50 — z-score blend, weight 0.3',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'zscore', weight: 0.3 }),
  },
  {
    key: 'rerank-zscore-p50-w05',
    label: 'Pool 50 — z-score blend, weight 0.5',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'zscore', weight: 0.5 }),
  },
  {
    key: 'rerank-zscore-p50-w07',
    label: 'Pool 50 — z-score blend, weight 0.7',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'zscore', weight: 0.7 }),
  },
  {
    key: 'rerank-zscore-p100-w03',
    label: 'Pool 100 — z-score blend, weight 0.3',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'zscore', weight: 0.3 }),
  },
  {
    key: 'rerank-zscore-p100-w05',
    label: 'Pool 100 — z-score blend, weight 0.5',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'zscore', weight: 0.5 }),
  },
  {
    key: 'rerank-zscore-p100-w07',
    label: 'Pool 100 — z-score blend, weight 0.7',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'zscore', weight: 0.7 }),
  },
  {
    key: 'rerank-fusion-p50-w025',
    label: 'Pool 50 — rank fusion, weight 0.25',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'fusion', weight: 0.25 }),
  },
  {
    key: 'rerank-fusion-p50-w05',
    label: 'Pool 50 — rank fusion, weight 0.5',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'fusion', weight: 0.5 }),
  },
  {
    key: 'rerank-fusion-p50-w1',
    label: 'Pool 50 — rank fusion, weight 1',
    settings: settings(CANDIDATE_POOL_SIZE, 0, 0, { mode: 'fusion', weight: 1 }),
  },
  {
    key: 'rerank-fusion-p100-w025',
    label: 'Pool 100 — rank fusion, weight 0.25',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'fusion', weight: 0.25 }),
  },
  {
    key: 'rerank-fusion-p100-w05',
    label: 'Pool 100 — rank fusion, weight 0.5',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'fusion', weight: 0.5 }),
  },
  {
    key: 'rerank-fusion-p100-w1',
    label: 'Pool 100 — rank fusion, weight 1',
    settings: settings(EVALUATION_CANDIDATES, 0, 0, { mode: 'fusion', weight: 1 }),
  },
];

const REFERENCE_POPULARITY = 'popularity';
const REFERENCE_GENRE = 'genre';
const BASELINE_LIMIT_4 = 'baseline-limit-4';

const pathSchema = z.string().trim().min(1);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

function inputPath(name: string, environmentName: string): string {
  const parsed = pathSchema.safeParse(argument(name) ?? process.env[environmentName]);

  if (!parsed.success) {
    throw new Error(`Provide --${name} <path> or set ${environmentName}`);
  }

  return resolve(parsed.data);
}

function outputPath(): string {
  const value = argument('output');

  if (value === undefined) {
    return fileURLToPath(
      new URL('../../../../docs/evaluation-experiments-2026-11-23.md', import.meta.url),
    );
  }

  const parsed = pathSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Provide a non-empty --output path');
  }

  return resolve(parsed.data);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function metric(value: number): string {
  return value.toFixed(4);
}

function signed(value: number): string {
  const formatted = value.toFixed(4);

  return value > 0 ? `+${formatted}` : formatted;
}

function percent(part: number, total: number): string {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

function row(label: string, metrics: RankingMetrics, detail?: string): Table['rows'][number] {
  return { label, metrics, ...(detail === undefined ? {} : { detail }) };
}

function renderTable(table: Table): string[] {
  const lines: string[] = [];

  lines.push(`### ${table.title}`);
  lines.push('');
  lines.push(table.blurb);
  lines.push('');
  lines.push(
    `| Config | Recall@${String(METRICS_DEPTH)} | NDCG@${String(METRICS_DEPTH)} | MRR | Detail |`,
  );
  lines.push('| --- | --- | --- | --- | --- |');

  for (const entry of table.rows) {
    lines.push(
      `| ${entry.label} | ${metric(entry.metrics.recall)} | ${metric(
        entry.metrics.ndcg,
      )} | ${metric(entry.metrics.mrr)} | ${entry.detail ?? '—'} |`,
    );
  }

  lines.push('');

  return lines;
}

function best(
  keys: readonly string[],
  metrics: ReadonlyMap<string, RankingMetrics>,
  field: keyof RankingMetrics,
): { key: string; value: number } {
  let bestKey = keys[0] ?? '';
  let bestValue = Number.NEGATIVE_INFINITY;

  for (const key of keys) {
    const value = metrics.get(key)?.[field] ?? Number.NEGATIVE_INFINITY;

    if (value > bestValue) {
      bestKey = key;
      bestValue = value;
    }
  }

  return { key: bestKey, value: bestValue };
}

function labelFor(key: string): string {
  for (const config of CONFIGS) {
    if (config.key === key) {
      return config.label;
    }
  }

  return key;
}

function value(metrics: ReadonlyMap<string, RankingMetrics>, key: string): RankingMetrics {
  return metrics.get(key) ?? { recall: 0, ndcg: 0, mrr: 0 };
}

function winners(
  keys: readonly string[],
  metrics: ReadonlyMap<string, RankingMetrics>,
  field: keyof RankingMetrics,
  reference: number,
): string {
  const beating = keys.filter((key) => value(metrics, key)[field] > reference);

  return beating.length === 0 ? 'none' : beating.map((key) => labelFor(key)).join('; ');
}

function findings(metrics: ReadonlyMap<string, RankingMetrics>): string[] {
  const tasteKeys = CONFIGS.map((config) => config.key);
  const popularity = value(metrics, REFERENCE_POPULARITY);
  const genre = value(metrics, REFERENCE_GENRE);
  const lines: string[] = [];

  const bestRecall = best(tasteKeys, metrics, 'recall');
  const bestNdcg = best(tasteKeys, metrics, 'ndcg');
  const bestMrr = best(tasteKeys, metrics, 'mrr');
  const baseline = value(metrics, 'pool-100');
  const committed = value(metrics, BASELINE_LIMIT_4);
  const pool50 = value(metrics, 'pool-50');
  const pool500 = value(metrics, 'pool-500');
  const pool50Both = value(metrics, 'pool-50-tilt-add');
  const pool50Moved = value(metrics, 'pool-50-tilt-move');
  const pool200 = value(metrics, 'pool-200');
  const pool200Both = value(metrics, 'pool-200-tilt-add');
  const pool50HighTilt = value(metrics, 'pool-50-t050');
  const pool100HighTilt = value(metrics, 'pool-100-t050');

  const anyWinner = (['recall', 'ndcg', 'mrr'] as const).some((field) =>
    tasteKeys.some((key) => value(metrics, key)[field] > popularity[field]),
  );

  lines.push(
    `- Against the popularity baseline (Recall@${String(METRICS_DEPTH)} ${metric(
      popularity.recall,
    )}, NDCG@${String(METRICS_DEPTH)} ${metric(popularity.ndcg)}, MRR ${metric(
      popularity.mrr,
    )}): configs beating it are Recall@${String(METRICS_DEPTH)}: ${winners(
      tasteKeys,
      metrics,
      'recall',
      popularity.recall,
    )}; NDCG@${String(METRICS_DEPTH)}: ${winners(
      tasteKeys,
      metrics,
      'ndcg',
      popularity.ndcg,
    )}; MRR: ${winners(tasteKeys, metrics, 'mrr', popularity.mrr)}.${
      anyWinner ? '' : ' No taste config wins on any of the three.'
    }`,
  );
  lines.push(
    `- Closest config: **${labelFor(bestRecall.key)}** at Recall@${String(
      METRICS_DEPTH,
    )} ${metric(bestRecall.value)} (${signed(bestRecall.value - popularity.recall)}), NDCG@${String(
      METRICS_DEPTH,
    )} ${metric(bestNdcg.value)} (${signed(bestNdcg.value - popularity.ndcg)}), MRR ${metric(
      bestMrr.value,
    )} (${signed(bestMrr.value - popularity.mrr)}).`,
  );
  lines.push(
    `- Method parity: scanning the pool to depth 100 moves production MRR from ${metric(
      committed.mrr,
    )} (four delivered picks) to ${metric(baseline.mrr)}; Recall@${String(
      METRICS_DEPTH,
    )} and NDCG@${String(METRICS_DEPTH)} are unchanged (${metric(
      committed.recall,
    )} → ${metric(baseline.recall)} and ${metric(committed.ndcg)} → ${metric(baseline.ndcg)}).`,
  );
  lines.push(
    `- Pool size: Recall@${String(METRICS_DEPTH)} and NDCG@${String(
      METRICS_DEPTH,
    )} are flat from pool 50 to 500 (${metric(pool50.recall)} → ${metric(
      pool500.recall,
    )} and ${metric(pool50.ndcg)} → ${metric(pool500.ndcg)}). At the common MRR depth 100, MRR rises ${metric(
      baseline.mrr,
    )} (pool 100) → ${metric(pool200.mrr)} (200) → ${metric(pool500.mrr)} (500), still ${signed(
      pool500.mrr - popularity.mrr,
    )} against popularity. Pool 50's MRR (${metric(
      pool50.mrr,
    )}) can only scan 50 films and is not directly comparable. Deeper cosine retrieval does not close the recall gap.`,
  );
  lines.push(
    `- Pool-stage tilt: at pool 50, tilt at pool + rerank lifts Recall@${String(
      METRICS_DEPTH,
    )} ${metric(pool50.recall)} → ${metric(pool50Both.recall)}, NDCG@${String(
      METRICS_DEPTH,
    )} ${metric(pool50.ndcg)} → ${metric(pool50Both.ndcg)}, MRR ${metric(
      pool50.mrr,
    )} → ${metric(pool50Both.mrr)}. Moving the tilt to the pool only (rerank tilt 0) collapses it to ${metric(
      pool50Moved.recall,
    )} / ${metric(pool50Moved.ndcg)} / ${metric(
      pool50Moved.mrr,
    )}. At pool 200 the additive variant is flat (${metric(pool200.recall)} / ${metric(
      pool200.ndcg,
    )} / ${metric(pool200.mrr)} → ${metric(pool200Both.recall)} / ${metric(
      pool200Both.ndcg,
    )} / ${metric(pool200Both.mrr)}).`,
  );
  lines.push(
    `- Rerank tilt sweep: the effect is monotone across 0.05 → 0.50. Pool 50 ends at ${metric(
      pool50HighTilt.recall,
    )} / ${metric(pool50HighTilt.ndcg)} / ${metric(
      pool50HighTilt.mrr,
    )}; pool 100 ends at ${metric(pool100HighTilt.recall)} / ${metric(
      pool100HighTilt.ndcg,
    )} / ${metric(pool100HighTilt.mrr)}. Tilt 0.50 at pool 100 clears the genre baseline (${metric(
      genre.recall,
    )} / ${metric(genre.ndcg)} / ${metric(
      genre.mrr,
    )}) on all three metrics but still trails popularity. The sweep has not saturated at 0.50; higher values were not tested.`,
  );

  return lines;
}

function renderReport(input: {
  coverage: CoverageStats;
  split: SplitStats;
  users: {
    mappedUsers: number;
    eligibleUsers: number;
    evaluatedUsers: number;
    skippedNoLikes: number;
    coldStart: number;
  };
  tables: Table[];
  findings: readonly string[];
}): string {
  const { coverage, split, users, tables, findings: bullets } = input;
  const lines: string[] = [];

  lines.push('# Ranking experiments — MovieLens held-out ratings');
  lines.push('');
  lines.push('Controlled offline experiments on the committed evaluation split. No served code or');
  lines.push('production constant is modified by running the harness: every config is computed');
  lines.push('inside it. The rows labelled "(production)" use the CURRENT production constants,');
  lines.push(
    `so they track whatever the code says today (currently tilt ${String(QUALITY_TILT)});`,
  );
  lines.push('rows with explicit literal tilt values are fixed experiment parameters.');
  lines.push('');
  lines.push('## Setup (identical to the committed baseline run)');
  lines.push('');
  lines.push(`- Catalog films: ${count(coverage.catalogMovies)}; all with an embedding.`);
  lines.push(
    `- Catalog films reachable through MovieLens links: ${count(
      coverage.catalogMappedFilms,
    )} (${percent(coverage.catalogMappedFilms, coverage.catalogMovies)} of the catalog).`,
  );
  lines.push(
    `- Users: ${count(split.users)} mapped; ${count(split.eligibleUsers)} eligible (at least ${String(
      MIN_USER_RATINGS,
    )} ratings); ${count(users.skippedNoLikes)} skipped for no held-out like; ${count(
      users.coldStart,
    )} cold start; ${count(users.evaluatedUsers)} evaluated.`,
  );
  lines.push(
    `- Ratings: ${count(split.trainRatings)} train, ${count(split.testRatings)} test (oldest ${String(
      Math.round((1 - TEST_FRACTION) * 100),
    )}% / newest ${String(Math.round(TEST_FRACTION * 100))}% per user).`,
  );
  lines.push(
    `- Relevance: a held-out test rating >= ${String(
      LIKE_THRESHOLD,
    )} is relevant. Recall@${String(METRICS_DEPTH)} and NDCG@${String(
      METRICS_DEPTH,
    )} use the top ${String(METRICS_DEPTH)}; MRR scans the full returned ranking.`,
  );
  lines.push(
    `- Universe: every catalog film with an embedding, minus the user's train-rated films. Held-out test films stay eligible.`,
  );
  lines.push(
    `- Every taste config starts from the same top-${String(
      EVALUATION_MAX_POOL,
    )} cosine buffer for that user. The production constants are pool \`CANDIDATE_POOL_SIZE\` = ${String(
      CANDIDATE_POOL_SIZE,
    )}, tilt \`QUALITY_TILT_WEIGHT\` = ${String(
      QUALITY_TILT,
    )}, diversity penalty ${String(DEFAULT_DIVERSITY_PENALTY)}, delivery limit ${String(
      MAX_RECOMMENDATIONS,
    )}; the baselines keep retrieval depth ${String(EVALUATION_CANDIDATES)}.`,
  );
  lines.push(
    '- Baselines: popularity is vote count descending (films without votes last, id ascending); genre uses the top 3 train-liked genres and shared-genre count.',
  );
  lines.push(
    '- Deterministic: fixed split, deterministic SQL ordering and id tie-breaks, no randomness.',
  );
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    'Rerank scoring: every config keeps the same greedy diversity pass, diversity penalty and tie-breaks; only the base score changes. `tilt` uses `similarity + tiltWeight * quality`. `zscore` standardises similarity and quality across the pool with the population standard deviation (a zero-variance dimension scores 0) and uses `(1 - weight) * z(similarity) + weight * z(quality)`. `fusion` uses 1-based ranks within the pool (similarity descending; popularity by vote count descending, missing counts last; ties by movie id) and scores `1 / (k + rankSimilarity) + weight / (k + rankPopularity)`, with `k` defaulting to 60.',
  );
  lines.push('');

  for (const table of tables) {
    lines.push(...renderTable(table));
  }

  lines.push('## Findings');
  lines.push('');
  lines.push(...bullets);
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push(
    `- Small sample: ${count(users.evaluatedUsers)} users from \`ratings_small.csv\` (~100k ratings), not the full MovieLens set. Means have wide uncertainty; no confidence intervals or significance tests.`,
  );
  lines.push(
    '- Era mismatch: ratings stop in 2017 while the catalog is a 2026 snapshot. Post-2017 films can occupy slots but can never be relevant.',
  );
  lines.push(
    `- Coverage: only ${percent(
      coverage.catalogMappedFilms,
      coverage.catalogMovies,
    )} of the catalog is reachable through MovieLens links, so most ranked films can never appear in a held-out test set.`,
  );
  lines.push(
    `- Pool/universe overlap: the taste pool is drawn from all ${count(
      coverage.catalogMovies,
    )} embedded films while relevant held-out films live in the ${count(
      coverage.catalogMappedFilms,
    )} linked subset, which caps achievable recall for every taste config.`,
  );
  lines.push(
    `- MRR depth is the ranking length: ${String(RANKING_DEPTH)} for pools ${String(
      EVALUATION_CANDIDATES,
    )}+ and ${String(CANDIDATE_POOL_SIZE)} for the pool-50 configs, so pool 50 cannot find a relevant film beyond rank 50.`,
  );
  lines.push(
    `- Pool-stage tilt is a post-fetch approximation: it reorders the top-${String(
      EVALUATION_MAX_POOL,
    )} cosine buffer and slices the pool, rather than issuing a SQL \`ORDER BY similarity + tilt * quality\` over the whole catalog. A film outside that buffer could enter a true SQL-side ordering.`,
  );
  lines.push(
    '- "Tilt at pool + rerank" applies the production tilt twice (pool ordering and greedy rerank); "tilt at pool only" moves it to the pool stage. Both are reported because the brief asked for the additive variant and the moved variant isolates the diagnosis.',
  );
  lines.push(
    '- Diversity penalty stays at the production 0.3 in every config; only pool size and quality tilt vary.',
  );
  lines.push(
    '- The popularity and genre baselines are untuned reference points, not tuned competitors.',
  );
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const linksPath = inputPath('links', 'MOVIELENS_LINKS_CSV');
  const ratingsPath = inputPath('ratings', 'MOVIELENS_RATINGS_CSV');
  const output = outputPath();
  const { db, pool } = createDatabase();

  try {
    const { ratings, coverage } = await loadEvaluationData({ db, linksPath, ratingsPath });
    const universe = await loadCatalogUniverse(db);
    const universeById = new Map<number, CatalogEntry>(
      universe.map((entry) => [entry.movieId, entry]),
    );
    const embeddings = await loadMovieEmbeddings(db, [
      ...new Set(ratings.map((rating) => rating.movieId)),
    ]);
    const { splits, stats: split } = splitRatings(ratings);
    const results = new Map<string, RankingMetrics[]>(
      [...CONFIGS.map((config) => config.key), REFERENCE_POPULARITY, REFERENCE_GENRE].map((key) => [
        key,
        [],
      ]),
    );
    const limitFour: RankingMetrics[] = [];
    const popularity: RankingMetrics[] = [];
    const genre: RankingMetrics[] = [];
    let skippedNoLikes = 0;
    let coldStart = 0;

    for (const userSplit of splits) {
      const relevant = likedIds(userSplit.test);

      if (relevant.size === 0) {
        skippedNoLikes += 1;
        continue;
      }

      const taste = buildTasteVector(userSplit.train, embeddings);

      if (taste.vector === null) {
        coldStart += 1;
        continue;
      }

      const likedEntries: CatalogEntry[] = [];

      for (const rating of userSplit.train) {
        if (rating.rating < LIKE_THRESHOLD) {
          continue;
        }

        const entry = universeById.get(rating.movieId);

        if (entry !== undefined) {
          likedEntries.push(entry);
        }
      }

      const trainIds = userSplit.train.map((rating) => rating.movieId);
      const buffer = await fetchNearestPool(db, {
        embedding: taste.vector,
        excludeIds: trainIds,
        size: EVALUATION_MAX_POOL,
      });

      for (const config of CONFIGS) {
        const ranked = rankCandidates(buffer, config.settings);

        results.get(config.key)?.push(evaluateRanking(ranked, relevant));

        if (config.key === 'pool-100') {
          limitFour.push(evaluateRanking(ranked.slice(0, MAX_RECOMMENDATIONS), relevant));
        }
      }

      const excluded = new Set(trainIds);
      const eligible = universe.filter((entry) => !excluded.has(entry.movieId));

      popularity.push(evaluateRanking(rankByPopularity(eligible, EVALUATION_CANDIDATES), relevant));
      genre.push(
        evaluateRanking(
          rankByGenre(eligible, topLikedGenres(likedEntries), EVALUATION_CANDIDATES),
          relevant,
        ),
      );

      if (limitFour.length % 50 === 0) {
        console.error(`Ranked ${String(limitFour.length)} users`);
      }
    }

    const means = new Map<string, RankingMetrics>();

    for (const [key, values] of results) {
      means.set(key, meanMetrics(values));
    }

    const popularityMetrics = meanMetrics(popularity);
    const genreMetrics = meanMetrics(genre);

    means.set(REFERENCE_POPULARITY, popularityMetrics);
    means.set(REFERENCE_GENRE, genreMetrics);
    means.set(BASELINE_LIMIT_4, meanMetrics(limitFour));

    const get = (key: string): RankingMetrics => means.get(key) ?? meanMetrics([]);
    const tables: Table[] = [
      {
        title: '1. Method parity (MRR depth fix)',
        blurb: `Production's top four are unchanged; only how far MRR scans differs. The baselines already scanned ${String(
          EVALUATION_CANDIDATES,
        )}.`,
        rows: [
          row(
            'Production as committed (4 delivered picks)',
            get(BASELINE_LIMIT_4),
            `MRR depth ${String(MAX_RECOMMENDATIONS)}`,
          ),
          row(
            'Production, corrected (rank pool to 100)',
            get('pool-100'),
            `MRR depth ${String(RANKING_DEPTH)}`,
          ),
          row(
            'Popularity baseline',
            popularityMetrics,
            `MRR depth ${String(EVALUATION_CANDIDATES)}`,
          ),
          row('Genre baseline', genreMetrics, `MRR depth ${String(EVALUATION_CANDIDATES)}`),
        ],
      },
      {
        title: `2. Pool size (tilt ${String(QUALITY_TILT)} at rerank)`,
        blurb:
          'Does deeper cosine retrieval close the gap? Each pool is a prefix of the same top-500 buffer.',
        rows: [
          row('Pool 50 (production)', get('pool-50'), 'MRR depth 50'),
          row('Pool 100 (baseline parity)', get('pool-100'), 'MRR depth 100'),
          row('Pool 200', get('pool-200'), 'MRR depth 100'),
          row('Pool 500', get('pool-500'), 'MRR depth 100'),
          row('Popularity baseline', popularityMetrics, 'reference'),
          row('Genre baseline', genreMetrics, 'reference'),
        ],
      },
      {
        title: '3. Quality tilt at the pool stage',
        blurb: `Pool ordering is \`similarity + ${String(
          QUALITY_TILT,
        )} * quality\` over the top-${String(
          EVALUATION_MAX_POOL,
        )} cosine buffer, then the pool is sliced. "Add" keeps the production rerank tilt; "only" moves it to the pool stage.`,
        rows: [
          row('Pool 50 — cosine order (tilt at rerank only)', get('pool-50'), 'reference'),
          row('Pool 50 — tilt at pool + rerank', get('pool-50-tilt-add')),
          row('Pool 50 — tilt at pool only', get('pool-50-tilt-move')),
          row('Pool 200 — cosine order (tilt at rerank only)', get('pool-200'), 'reference'),
          row('Pool 200 — tilt at pool + rerank', get('pool-200-tilt-add')),
          row('Pool 200 — tilt at pool only', get('pool-200-tilt-move')),
          row('Popularity baseline', popularityMetrics, 'reference'),
          row('Genre baseline', genreMetrics, 'reference'),
        ],
      },
      {
        title: '4. Rerank tilt sweep',
        blurb:
          'Quality tilt inside the greedy rerank, at the production pool and at the baseline-parity pool.',
        rows: [
          row('Pool 50 — tilt 0.05', get('pool-50-t005')),
          row(`Pool 50 — tilt ${String(QUALITY_TILT)} (production)`, get('pool-50')),
          row('Pool 50 — tilt 0.25', get('pool-50-t025')),
          row('Pool 50 — tilt 0.50', get('pool-50-t050')),
          row('Pool 100 — tilt 0.05', get('pool-100-t005')),
          row(`Pool 100 — tilt ${String(QUALITY_TILT)}`, get('pool-100')),
          row('Pool 100 — tilt 0.25', get('pool-100-t025')),
          row('Pool 100 — tilt 0.50', get('pool-100-t050')),
          row('Popularity baseline', popularityMetrics, 'reference'),
          row('Genre baseline', genreMetrics, 'reference'),
        ],
      },
      {
        title: '5. Rerank scoring: z-score blend and rank fusion',
        blurb:
          'Pool stage stays pure cosine order (tilt 0), then the greedy diversity rerank uses an alternative base score. Z-score standardises similarity and quality across the pool; rank fusion combines reciprocal similarity and popularity ranks with k = 60. Pool 50 rankings are capped at 50 items; pool 100 scans to depth 100.',
        rows: [
          row(labelFor('rerank-zscore-p50-w03'), get('rerank-zscore-p50-w03'), 'MRR depth 50'),
          row(labelFor('rerank-zscore-p50-w05'), get('rerank-zscore-p50-w05'), 'MRR depth 50'),
          row(labelFor('rerank-zscore-p50-w07'), get('rerank-zscore-p50-w07'), 'MRR depth 50'),
          row(labelFor('rerank-fusion-p50-w025'), get('rerank-fusion-p50-w025'), 'MRR depth 50'),
          row(labelFor('rerank-fusion-p50-w05'), get('rerank-fusion-p50-w05'), 'MRR depth 50'),
          row(labelFor('rerank-fusion-p50-w1'), get('rerank-fusion-p50-w1'), 'MRR depth 50'),
          row(labelFor('rerank-zscore-p100-w03'), get('rerank-zscore-p100-w03'), 'MRR depth 100'),
          row(labelFor('rerank-zscore-p100-w05'), get('rerank-zscore-p100-w05'), 'MRR depth 100'),
          row(labelFor('rerank-zscore-p100-w07'), get('rerank-zscore-p100-w07'), 'MRR depth 100'),
          row(labelFor('rerank-fusion-p100-w025'), get('rerank-fusion-p100-w025'), 'MRR depth 100'),
          row(labelFor('rerank-fusion-p100-w05'), get('rerank-fusion-p100-w05'), 'MRR depth 100'),
          row(labelFor('rerank-fusion-p100-w1'), get('rerank-fusion-p100-w1'), 'MRR depth 100'),
          row('Popularity baseline', popularityMetrics, 'reference'),
          row('Genre baseline', genreMetrics, 'reference'),
        ],
      },
    ];
    const report = renderReport({
      coverage,
      split,
      users: {
        mappedUsers: coverage.keptUsers,
        eligibleUsers: split.eligibleUsers,
        evaluatedUsers: limitFour.length,
        skippedNoLikes,
        coldStart,
      },
      tables,
      findings: findings(means),
    });

    console.log(report);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${report}\n`, 'utf8');
    console.error(`Wrote ${output}`);
  } finally {
    await pool.end();
  }
}

await main();
