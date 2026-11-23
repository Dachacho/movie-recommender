import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDatabase } from '../db/client.js';
import { CANDIDATE_POOL_SIZE } from '../modules/recommendations/types.js';
import {
  DEFAULT_DIVERSITY_PENALTY,
  LOG_VOTE_SCALE,
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
import { EVALUATION_CANDIDATES, GENRE_PROFILE_SIZE, rankUser, topLikedGenres } from './rank.js';
import {
  LIKE_THRESHOLD,
  METRICS_DEPTH,
  evaluateRanking,
  likedIds,
  meanMetrics,
  type RankingMetrics,
} from './metrics.js';
import { MIN_USER_RATINGS, TEST_FRACTION, splitRatings, type SplitStats } from './split.js';
import { buildTasteVector } from './taste.js';

interface EvaluationUsers {
  mappedUsers: number;
  eligibleUsers: number;
  evaluatedUsers: number;
  skippedNoLikes: number;
  coldStart: number;
}

interface EvaluationOutcome {
  coverage: CoverageStats;
  split: SplitStats;
  users: EvaluationUsers;
  metrics: {
    showcase: RankingMetrics;
    popularity: RankingMetrics;
    genre: RankingMetrics;
  };
}

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
    return fileURLToPath(new URL('../../../../docs/evaluation-2026-11-23.md', import.meta.url));
  }

  const parsed = pathSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Provide a non-empty --output path');
  }

  return resolve(parsed.data);
}

function percent(part: number, total: number): string {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

function metric(value: number): string {
  return value.toFixed(4);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function renderReport(outcome: EvaluationOutcome): string {
  const { coverage, split, users, metrics } = outcome;
  const lines: string[] = [];

  lines.push('# Ranking evaluation — MovieLens held-out ratings');
  lines.push('');
  lines.push(
    'Offline harness output. These numbers are informational; no weights were tuned in this run.',
  );
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push('| Stage | Count | Share |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Catalog films | ${count(coverage.catalogMovies)} | — |`);
  lines.push(
    `| Links parsed (valid) | ${count(coverage.validLinks)} | ${percent(
      coverage.validLinks,
      coverage.linkRows,
    )} of ${count(coverage.linkRows)} link rows |`,
  );
  lines.push(
    `| Catalog films reachable through links | ${count(coverage.catalogMappedFilms)} | ${percent(
      coverage.catalogMappedFilms,
      coverage.catalogMovies,
    )} of the catalog |`,
  );
  lines.push(
    `| Ratings parsed (valid) | ${count(coverage.ratingRows - coverage.invalidRatings)} | ${percent(
      coverage.ratingRows - coverage.invalidRatings,
      coverage.ratingRows,
    )} of ${count(coverage.ratingRows)} rating rows |`,
  );
  lines.push(
    `| Ratings mapped into the catalog | ${count(coverage.keptRatings)} | ${percent(
      coverage.keptRatings,
      coverage.ratingRows,
    )} of rating rows |`,
  );
  lines.push(`| Distinct users kept | ${count(coverage.keptUsers)} | — |`);
  lines.push(`| Distinct films rated | ${count(coverage.keptMovies)} | — |`);
  lines.push('');
  lines.push(
    `Links dropped: ${count(coverage.invalidLinks)} invalid, ${count(
      coverage.duplicateLinks,
    )} duplicate MovieLens ids.`,
  );
  lines.push(
    `Ratings dropped: ${count(coverage.invalidRatings)} invalid, ${count(
      coverage.unmappedRatings,
    )} without a TMDB link, ${count(coverage.missingFromCatalog)} not in the catalog, ${count(
      coverage.duplicateRatings,
    )} duplicate user-film pairs.`,
  );
  lines.push('');
  lines.push('## Split');
  lines.push('');
  lines.push(
    `- Users: ${count(split.users)} mapped users; ${count(split.eligibleUsers)} eligible; ${count(split.skippedUsers)} skipped for fewer than ${String(MIN_USER_RATINGS)} ratings.`,
  );
  lines.push(`- Ratings: ${count(split.trainRatings)} train, ${count(split.testRatings)} test.`);
  lines.push(
    `- Rule: per user, sort by timestamp ascending (movie id ties), keep the oldest ${String(
      Math.round((1 - TEST_FRACTION) * 100),
    )}% as train and the newest ${String(Math.round(TEST_FRACTION * 100))}% as test.`,
  );
  lines.push('');
  lines.push('## Evaluation users');
  lines.push('');
  lines.push(`- Mapped users: ${count(users.mappedUsers)}`);
  lines.push(`- Eligible users in the split: ${count(users.eligibleUsers)}`);
  lines.push(
    `- Skipped, no held-out like (test rating >= ${String(LIKE_THRESHOLD)}): ${count(
      users.skippedNoLikes,
    )}`,
  );
  lines.push(`- Skipped, null taste vector (cold start): ${count(users.coldStart)}`);
  lines.push(`- Evaluated on all three strategies: ${count(users.evaluatedUsers)}`);
  lines.push('');
  lines.push(`## Metrics (mean per evaluated user)`);
  lines.push('');
  lines.push(
    `| Strategy | Recall@${String(METRICS_DEPTH)} | NDCG@${String(METRICS_DEPTH)} | MRR | Users |`,
  );
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(
    `| Production ranking (taste + quality tilt + diversity) | ${metric(
      metrics.showcase.recall,
    )} | ${metric(metrics.showcase.ndcg)} | ${metric(metrics.showcase.mrr)} | ${count(
      users.evaluatedUsers,
    )} |`,
  );
  lines.push(
    `| Popularity baseline | ${metric(metrics.popularity.recall)} | ${metric(
      metrics.popularity.ndcg,
    )} | ${metric(metrics.popularity.mrr)} | ${count(users.evaluatedUsers)} |`,
  );
  lines.push(
    `| Genre baseline | ${metric(metrics.genre.recall)} | ${metric(
      metrics.genre.ndcg,
    )} | ${metric(metrics.genre.mrr)} | ${count(users.evaluatedUsers)} |`,
  );
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push(
    `- Candidate depth N = ${String(
      EVALUATION_CANDIDATES,
    )} for retrieval and both baselines; the production recommendation limit is ${String(
      MAX_RECOMMENDATIONS,
    )}.`,
  );
  lines.push(
    `- Production path: \`findNearestMovies\` (top ${String(
      EVALUATION_CANDIDATES,
    )} films the user did not rate in train, exploration 0) → \`selectDiverse({ limit: ${String(
      MAX_RECOMMENDATIONS,
    )} })\`.`,
  );
  lines.push(
    `- Quality tilt in effect: \`QUALITY_TILT_WEIGHT = ${String(
      QUALITY_TILT_WEIGHT,
    )}\` with \`LOG_VOTE_SCALE = ${String(LOG_VOTE_SCALE)}\`; diversity penalty ${String(
      DEFAULT_DIVERSITY_PENALTY,
    )}.`,
  );
  lines.push('- Taste vector: the committed `computeTasteVector` over train ratings.');
  lines.push(
    '- Exclusions: train-rated film ids only. Held-out test films stay eligible; excluding them would leave no relevant item to rank and force every metric to zero.',
  );
  lines.push(
    '- Eligible universe: catalog films with an embedding, minus the user’s train-rated films.',
  );
  lines.push(
    '- Popularity baseline: vote count descending (films without a vote count last), then id ascending.',
  );
  lines.push(
    `- Genre baseline: top ${String(
      GENRE_PROFILE_SIZE,
    )} genres from train likes (rating >= ${String(
      LIKE_THRESHOLD,
    )}) by like count, genre name breaking ties; films ranked by shared genres descending, then id ascending.`,
  );
  lines.push(
    `- Relevance: held-out test ratings >= ${String(
      LIKE_THRESHOLD,
    )} are relevant (binary). Recall@${String(METRICS_DEPTH)}, NDCG@${String(
      METRICS_DEPTH,
    )} and MRR are means per user; MRR scans the full ranked list (${String(
      EVALUATION_CANDIDATES,
    )} for baselines, ${String(MAX_RECOMMENDATIONS)} for the production path).`,
  );
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push(
    '- Sample: `ratings_small.csv` holds ~100k MovieLens ratings from 700 users, not the full 26M-rating set.',
  );
  lines.push(
    '- Era mismatch: the ratings stop in 2017 while the catalog is a 2026 snapshot. Post-2017 films cannot appear in any test set but can occupy recommendation slots, which depresses recall for every strategy.',
  );
  lines.push(
    '- Catalog overlap: only the popularity-curated catalog is eligible; ratings for films outside it are dropped.',
  );
  lines.push(
    `- Production parity: the harness retrieves N = ${String(
      EVALUATION_CANDIDATES,
    )} nearest films before the same \`selectDiverse\` call; the API's production candidate pool is \`CANDIDATE_POOL_SIZE\` = ${String(
      CANDIDATE_POOL_SIZE,
    )}, so borderline picks can differ from the live endpoint.`,
  );
  lines.push(
    '- Baselines are untuned: popularity uses vote count only, and the genre baseline uses a three-genre profile with a raw shared-genre count.',
  );
  lines.push(
    '- Single deterministic split, mean over users, no confidence intervals or significance test.',
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
    const showcase: RankingMetrics[] = [];
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

      const ranking = await rankUser(db, {
        embedding: taste.vector,
        excludedIds: userSplit.train.map((rating) => rating.movieId),
        universe,
        likedGenres: topLikedGenres(likedEntries),
      });

      showcase.push(evaluateRanking(ranking.showcase, relevant));
      popularity.push(evaluateRanking(ranking.popularity, relevant));
      genre.push(evaluateRanking(ranking.genre, relevant));

      if (showcase.length % 100 === 0) {
        console.error(`Ranked ${String(showcase.length)} users`);
      }
    }

    const outcome: EvaluationOutcome = {
      coverage,
      split,
      users: {
        mappedUsers: coverage.keptUsers,
        eligibleUsers: split.eligibleUsers,
        evaluatedUsers: showcase.length,
        skippedNoLikes,
        coldStart,
      },
      metrics: {
        showcase: meanMetrics(showcase),
        popularity: meanMetrics(popularity),
        genre: meanMetrics(genre),
      },
    };
    const report = renderReport(outcome);

    console.log(report);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${report}\n`, 'utf8');
    console.error(`Wrote ${output}`);
  } finally {
    await pool.end();
  }
}

await main();
