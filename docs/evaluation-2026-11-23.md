# Ranking evaluation — MovieLens held-out ratings

Offline harness output. These numbers are informational; no weights were tuned in this run.

## Coverage

| Stage | Count | Share |
| --- | --- | --- |
| Catalog films | 40,000 | — |
| Links parsed (valid) | 45,624 | 99.5% of 45,843 link rows |
| Catalog films reachable through links | 9,847 | 24.6% of the catalog |
| Ratings parsed (valid) | 100,004 | 100.0% of 100,004 rating rows |
| Ratings mapped into the catalog | 84,957 | 85.0% of rating rows |
| Distinct users kept | 671 | — |
| Distinct films rated | 4,908 | — |

Links dropped: 219 invalid, 0 duplicate MovieLens ids.
Ratings dropped: 0 invalid, 106 without a TMDB link, 14,941 not in the catalog, 0 duplicate user-film pairs.

## Split

- Users: 671 mapped users; 671 eligible; 0 skipped for fewer than 10 ratings.
- Ratings: 68,236 train, 16,721 test.
- Rule: per user, sort by timestamp ascending (movie id ties), keep the oldest 80% as train and the newest 20% as test.

## Evaluation users

- Mapped users: 671
- Eligible users in the split: 671
- Skipped, no held-out like (test rating >= 4): 13
- Skipped, null taste vector (cold start): 0
- Evaluated on all three strategies: 658

## Metrics (mean per evaluated user)

| Strategy | Recall@4 | NDCG@4 | MRR | Users |
| --- | --- | --- | --- | --- |
| Production ranking (taste + quality tilt + diversity) | 0.0028 | 0.0068 | 0.0139 | 658 |
| Popularity baseline | 0.0082 | 0.0195 | 0.0579 | 658 |
| Genre baseline | 0.0046 | 0.0132 | 0.0374 | 658 |

## Configuration

- Candidate depth N = 100 for retrieval and both baselines; the production recommendation limit is 4.
- Production path: `findNearestMovies` (top 100 films the user did not rate in train) → `applyExploration(pool, 0)` → `selectDiverse({ limit: 4 })`.
- Quality tilt in effect: `QUALITY_TILT_WEIGHT = 0.12` with `LOG_VOTE_SCALE = 6`; diversity penalty 0.3.
- Taste vector: the committed `computeTasteVector` over train ratings.
- Exclusions: train-rated film ids only. Held-out test films stay eligible; excluding them would leave no relevant item to rank and force every metric to zero.
- Eligible universe: catalog films with an embedding, minus the user’s train-rated films.
- Popularity baseline: vote count descending (films without a vote count last), then id ascending.
- Genre baseline: top 3 genres from train likes (rating >= 4) by like count, genre name breaking ties; films ranked by shared genres descending, then id ascending.
- Relevance: held-out test ratings >= 4 are relevant (binary). Recall@4, NDCG@4 and MRR are means per user; MRR scans the full ranked list (100 for baselines, 4 for the production path).

## Caveats

- Sample: `ratings_small.csv` holds ~100k MovieLens ratings from 700 users, not the full 26M-rating set.
- Era mismatch: the ratings stop in 2017 while the catalog is a 2026 snapshot. Post-2017 films cannot appear in any test set but can occupy recommendation slots, which depresses recall for every strategy.
- Catalog overlap: only the popularity-curated catalog is eligible; ratings for films outside it are dropped.
- Production parity: the harness retrieves N = 100 nearest films before the same `selectDiverse` call; the API's production candidate pool is `CANDIDATE_POOL_SIZE` = 50, so borderline picks can differ from the live endpoint.
- Baselines are untuned: popularity uses vote count only, and the genre baseline uses a three-genre profile with a raw shared-genre count.
- Single deterministic split, mean over users, no confidence intervals or significance test.

