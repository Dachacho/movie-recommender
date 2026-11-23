# Ranking experiments — MovieLens held-out ratings

Controlled offline experiments on the committed evaluation split. No served code or
production constant changed: every config is computed inside the harness, and the
production weights remain the defaults.

## Setup (identical to the committed baseline run)

- Catalog films: 40,000; all with an embedding.
- Catalog films reachable through MovieLens links: 9,847 (24.6% of the catalog).
- Users: 671 mapped; 671 eligible (at least 10 ratings); 13 skipped for no held-out like; 0 cold start; 658 evaluated.
- Ratings: 68,236 train, 16,721 test (oldest 80% / newest 20% per user).
- Relevance: a held-out test rating >= 4 is relevant. Recall@4 and NDCG@4 use the top 4; MRR scans the full returned ranking.
- Universe: every catalog film with an embedding, minus the user's train-rated films. Held-out test films stay eligible.
- Every taste config starts from the same top-500 cosine buffer for that user. The production constants are pool `CANDIDATE_POOL_SIZE` = 50, tilt `QUALITY_TILT_WEIGHT` = 0.12, diversity penalty 0.3, delivery limit 4; the baselines keep retrieval depth 100.
- Baselines: popularity is vote count descending (films without votes last, id ascending); genre uses the top 3 train-liked genres and shared-genre count.
- Deterministic: fixed split, deterministic SQL ordering and id tie-breaks, no randomness.

### 1. Method parity (MRR depth fix)

Production's top four are unchanged; only how far MRR scans differs. The baselines already scanned 100.

| Config | Recall@4 | NDCG@4 | MRR | Detail |
| --- | --- | --- | --- | --- |
| Production as committed (4 delivered picks) | 0.0028 | 0.0068 | 0.0139 | MRR depth 4 |
| Production, corrected (rank pool to 100) | 0.0028 | 0.0068 | 0.0218 | MRR depth 100 |
| Popularity baseline | 0.0082 | 0.0195 | 0.0579 | MRR depth 100 |
| Genre baseline | 0.0046 | 0.0132 | 0.0374 | MRR depth 100 |

### 2. Pool size (tilt 0.12 at rerank)

Does deeper cosine retrieval close the gap? Each pool is a prefix of the same top-500 buffer.

| Config | Recall@4 | NDCG@4 | MRR | Detail |
| --- | --- | --- | --- | --- |
| Pool 50 (production) | 0.0027 | 0.0068 | 0.0193 | MRR depth 50 |
| Pool 100 (baseline parity) | 0.0028 | 0.0068 | 0.0218 | MRR depth 100 |
| Pool 200 | 0.0028 | 0.0068 | 0.0234 | MRR depth 100 |
| Pool 500 | 0.0028 | 0.0068 | 0.0243 | MRR depth 100 |
| Popularity baseline | 0.0082 | 0.0195 | 0.0579 | reference |
| Genre baseline | 0.0046 | 0.0132 | 0.0374 | reference |

### 3. Quality tilt at the pool stage

Pool ordering is `similarity + 0.12 * quality` over the top-500 cosine buffer, then the pool is sliced. "Add" keeps the rerank tilt at 0.12; "only" moves it to the pool stage.

| Config | Recall@4 | NDCG@4 | MRR | Detail |
| --- | --- | --- | --- | --- |
| Pool 50 — cosine order (tilt at rerank only) | 0.0027 | 0.0068 | 0.0193 | reference |
| Pool 50 — tilt at pool + rerank | 0.0030 | 0.0071 | 0.0227 | — |
| Pool 50 — tilt at pool only | 0.0013 | 0.0027 | 0.0122 | — |
| Pool 200 — cosine order (tilt at rerank only) | 0.0028 | 0.0068 | 0.0234 | reference |
| Pool 200 — tilt at pool + rerank | 0.0028 | 0.0068 | 0.0243 | — |
| Pool 200 — tilt at pool only | 0.0011 | 0.0024 | 0.0111 | — |
| Popularity baseline | 0.0082 | 0.0195 | 0.0579 | reference |
| Genre baseline | 0.0046 | 0.0132 | 0.0374 | reference |

### 4. Rerank tilt sweep

Quality tilt inside the greedy rerank, at the production pool and at the baseline-parity pool.

| Config | Recall@4 | NDCG@4 | MRR | Detail |
| --- | --- | --- | --- | --- |
| Pool 50 — tilt 0.05 | 0.0017 | 0.0045 | 0.0146 | — |
| Pool 50 — tilt 0.12 (production) | 0.0027 | 0.0068 | 0.0193 | — |
| Pool 50 — tilt 0.25 | 0.0055 | 0.0120 | 0.0297 | — |
| Pool 50 — tilt 0.50 | 0.0064 | 0.0156 | 0.0385 | — |
| Pool 100 — tilt 0.05 | 0.0020 | 0.0048 | 0.0163 | — |
| Pool 100 — tilt 0.12 | 0.0028 | 0.0068 | 0.0218 | — |
| Pool 100 — tilt 0.25 | 0.0056 | 0.0123 | 0.0332 | — |
| Pool 100 — tilt 0.50 | 0.0068 | 0.0166 | 0.0453 | — |
| Popularity baseline | 0.0082 | 0.0195 | 0.0579 | reference |
| Genre baseline | 0.0046 | 0.0132 | 0.0374 | reference |

## Findings

- Against the popularity baseline (Recall@4 0.0082, NDCG@4 0.0195, MRR 0.0579): configs beating it are Recall@4: none; NDCG@4: none; MRR: none. No taste config wins on any of the three.
- Closest config: **Pool 100 — tilt 0.50** at Recall@4 0.0068 (-0.0014), NDCG@4 0.0166 (-0.0028), MRR 0.0453 (-0.0126).
- Method parity: scanning the pool to depth 100 moves production MRR from 0.0139 (four delivered picks) to 0.0218; Recall@4 and NDCG@4 are unchanged (0.0028 → 0.0028 and 0.0068 → 0.0068).
- Pool size: Recall@4 and NDCG@4 are flat from pool 50 to 500 (0.0027 → 0.0028 and 0.0068 → 0.0068). At the common MRR depth 100, MRR rises 0.0218 (pool 100) → 0.0234 (200) → 0.0243 (500), still -0.0336 against popularity. Pool 50's MRR (0.0193) can only scan 50 films and is not directly comparable. Deeper cosine retrieval does not close the recall gap.
- Pool-stage tilt: at pool 50, tilt at pool + rerank lifts Recall@4 0.0027 → 0.0030, NDCG@4 0.0068 → 0.0071, MRR 0.0193 → 0.0227. Moving the tilt to the pool only (rerank tilt 0) collapses it to 0.0013 / 0.0027 / 0.0122. At pool 200 the additive variant is flat (0.0028 / 0.0068 / 0.0234 → 0.0028 / 0.0068 / 0.0243).
- Rerank tilt sweep: the effect is monotone across 0.05 → 0.50. Pool 50 ends at 0.0064 / 0.0156 / 0.0385; pool 100 ends at 0.0068 / 0.0166 / 0.0453. Tilt 0.50 at pool 100 clears the genre baseline (0.0046 / 0.0132 / 0.0374) on all three metrics but still trails popularity. The sweep has not saturated at 0.50; higher values were not tested.

## Caveats

- Small sample: 658 users from `ratings_small.csv` (~100k ratings), not the full MovieLens set. Means have wide uncertainty; no confidence intervals or significance tests.
- Era mismatch: ratings stop in 2017 while the catalog is a 2026 snapshot. Post-2017 films can occupy slots but can never be relevant.
- Coverage: only 24.6% of the catalog is reachable through MovieLens links, so most ranked films can never appear in a held-out test set.
- Pool/universe overlap: the taste pool is drawn from all 40,000 embedded films while relevant held-out films live in the 9,847 linked subset, which caps achievable recall for every taste config.
- MRR depth is the ranking length: 100 for pools 100+ and 50 for the pool-50 configs, so pool 50 cannot find a relevant film beyond rank 50.
- Pool-stage tilt is a post-fetch approximation: it reorders the top-500 cosine buffer and slices the pool, rather than issuing a SQL `ORDER BY similarity + tilt * quality` over the whole catalog. A film outside that buffer could enter a true SQL-side ordering.
- "Tilt at pool + rerank" applies the 0.12 tilt twice (pool ordering and greedy rerank); "tilt at pool only" moves it to the pool stage. Both are reported because the brief asked for the additive variant and the moved variant isolates the diagnosis.
- Diversity penalty stays at the production 0.3 in every config; only pool size and quality tilt vary.
- The popularity and genre baselines are untuned reference points, not tuned competitors.

