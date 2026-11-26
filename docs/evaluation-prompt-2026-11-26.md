# Prompt evaluation — labelled natural-language set

Offline harness output for `npm run evaluate:prompt`. It scores the committed parser and ordering path. The harness does not modify production weights (0.5/0.5) or the shipped mood boost; parser coverage was widened in this step for the initial misses documented in the parser audit, and the mood boost was selected by the pre-declared held-out rule below.

## Setup and provenance

- Catalog: 40,000 films in local Postgres, 40,000 with an embedding.
- Embedding model: `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9`, dtype `q8`, mean pooling, normalized; embedding version `all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9/q8/mean/normalized/1`.
- Synthetic taste vector: deterministic 384-d unit vector from mulberry32 seed `0x5eed1a57`. It is not a real user and no guest data is read.
- Thriller taste vector: deterministic persona from 7 committed catalog ids (274, 807, 1949, 146233, 210577, 242582, 273481) rated five stars. Embeddings are read from Postgres and summed after sorting rows by movieId; no live API is used.
- Retrieval: production `recommendMovies` path (top-500 cosine buffer, quality tilt, diversity rerank), limit 4, exploration 0, filters from `parsePromptConstraints` and mood affinities from `parsePromptMood` when the prompt contains a supported phrase.
- Prompt texts are embedded one at a time, matching the route's single-prompt request. Batch size changes the vector under this q8 model (cosine 0.9888 between a single embed and the same prompt in a 34-prompt batch, 0.9909 in a two-prompt batch, 1.0000 across repeated single embeds), so batching would make this report disagree with the served route. Weights are passed explicitly to `combineQueryVector`; production `PROMPT_WEIGHT`/`TASTE_WEIGHT` remain 0.5/0.5.
- Mood sweep: the production 0.50 / 0.50 pairing for both personas at boost weights 0.00, 0.10, 0.15, 0.18, 0.20, 0.25.
- The harness only reads the catalog and embeddings (no writes, no whole-profile load, no server).

## Dataset

Hand-labelled prompts. Expected filters are exactly what the existing filter schema can express; genre weights are graded relevance for what the prompt semantically asks for.

| Group | Cases | With expected filters | With genre weights |
| --- | --- | --- | --- |
| explicit | 7 | 7 | 5 |
| soft | 11 | 1 | 11 |
| edge | 11 | 8 | 8 |
| control | 6 | 0 | 0 |
| **total** | **35** | **16** | **24** |

Mood split: 2 tune cases and 2 holdout cases. Tune cases inform the weight; holdout cases only validate it.

## Parser audit

The first run of the original 28-case set against the pre-change parser failed 8 cases. These are kept here as the audit trail for the widening work:

| Case | Prompt |
| --- | --- |
| explicit-runtime-range | between 2 and 3 hours |
| edge-rom-com-90s | a rom-com from the 90s |
| edge-romantic-comedy-80s | a romantic comedy from the 80's |
| edge-crime-70s-range | a 70s crime film between 90 and 120 minutes |
| edge-comedy-or-less | a 90 minutes or less comedy |
| edge-thriller-no-longer | a no longer than 2 hours thriller |
| edge-scary-under-90 | a scary movie under 90 minutes |
| edge-negated-horror | not a horror movie |

Rules added for those misses:

- rom-com/romcom => Comedy + Romance at the same mention index, ordered alphabetically on the tie.
- Apostrophe decades: "80's", "90's" and "1990's" alongside "'90s".
- Runtime ranges: between/from X and/to Y with a unit, and X–Y minutes.
- Trailing runtime bounds: "X minutes or less/fewer" => runtimeMax, "or more" => runtimeMin.
- "no longer than" => runtimeMax.
- "scary"/"frightening" => Horror.
- Negated genre mentions suppress the positive match without adding an excludeGenres filter.

**Follow-up user-reported miss:** `lighthearted movie i can watch with my girlfriend`

This exact prompt previously parsed to no filters, so a thriller-leaning taste pulled thriller/crime/horror picks. Added "lighthearted", "light-hearted" and "light hearted" as Comedy synonyms in the existing Comedy pattern. "Girlfriend" remains date context only: no Romance hard filter, and Romance stays a 0.5 graded label for this case. The taste blend remains 0.50/0.50; the additive mood term is evaluated separately in the Mood affinity section.

Follow-up hardening: "not only" is treated as inclusion; contractions (don't/dont, didn't, doesn't, wouldn't, won't) and "anything but"/"all but" are treated as negation; and range, directional and trailing runtime bounds now compete by mention index, with the existing first-bound-wins rule resolving contradictions.

Production retrieval still uses parser output, so these fixes directly change which filters are sent for the affected prompts.

## Metrics

- `parseAccuracy`: exact deep equality between `parsePromptConstraints` and the labelled `expectedFilters` for every case.
- `constraintSatisfaction`: fraction of cases with expected filters whose every returned pick satisfies genre OR, year bounds and runtime bounds. An empty result is vacuously true; the non-empty variant is reported beside it.
- `genrePrecision@4`: per pick, the maximum weight among its genres (0 when none match); per case, the mean over returned picks (0 for an empty result); then the mean over cases. Reported for all labelled cases, hard-filter cases and soft cases separately.
- `tasteSimilarity@4`: mean cosine between returned picks and the run's persona taste vector, over cases that returned picks. Diagnostic only.
- `tuneMoodPrecision@4` and `holdoutMoodPrecision@4`: mean graded genre precision over the mood cases in each split, regardless of case group.
- `nonMoodSoftPrecision@4`: mean graded genre precision over soft cases whose prompt contains no mood phrase. It must be identical across boost weights because the term is absent for those prompts.
- Empty-result counts are reported per weight pair because filtering can exhaust a pool.

## Parse coverage

Parse accuracy: 35/35 (100.0%).

No parse misses.

## Weight sweep

All five weight pairs use the same prompts, single-prompt embeddings and synthetic taste vector. Only the combination weights change. Mood prompts also receive the shipped additive mood term.

| Prompt / taste | Constraint satisfaction | Non-empty satisfaction | Empty results | Genre precision@4 all | Hard | Soft | Taste similarity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.35 / 0.65 | 16/16 (100.0%) | 16/16 | 0 | 0.7781 | 0.9923 | 0.5250 | 0.0860 |
| 0.50 / 0.50 | 16/16 (100.0%) | 16/16 | 0 | 0.8542 | 0.9923 | 0.6909 | 0.0539 |
| 0.65 / 0.35 | 16/16 (100.0%) | 16/16 | 0 | 0.8740 | 0.9923 | 0.7341 | 0.0232 |
| 0.80 / 0.20 | 16/16 (100.0%) | 16/16 | 0 | 0.9021 | 0.9885 | 0.8000 | 0.0029 |
| 1.00 / 0.00 | 16/16 (100.0%) | 16/16 | 0 | 0.8906 | 0.9885 | 0.7750 | -0.0152 |

## Mood affinity

The additive mood term applies only when the prompt contains one of the supported phrases. Per film it adds the strongest matching genre affinity multiplied by the boost weight, capped at that weight; it never filters, so it only tilts the pool ordering and the diversity rerank.

### Phrase table

| Phrase | Genre affinities (max per genre) |
| --- | --- |
| `lighthearted` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `light-hearted` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `light hearted` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `feel-good` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `feel good` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `feelgood` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `cozy` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |
| `cosy` | Comedy 0.6, Romance 1.0, Family 0.8, Animation 0.4 |

### Boost sweep

Production 0.50 / 0.50 pairing; the reported case is `edge-lighthearted-girlfriend`. The guard is defined for the thriller persona only.

| Persona | Boost | Reported guard | Tune mood precision@4 | Holdout mood precision@4 | Non-mood soft precision@4 | Non-empty constraints | Empty results | Taste similarity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Synthetic seed | 0.00 | not applicable | 0.7500 | 0.8000 | 0.6563 | 16/16 | 0 | 0.0575 |
| Synthetic seed | 0.10 | not applicable | 0.8250 | 0.8500 | 0.6563 | 16/16 | 0 | 0.0549 |
| Synthetic seed | 0.15 | not applicable | 0.8250 | 0.8500 | 0.6563 | 16/16 | 0 | 0.0550 |
| Synthetic seed | 0.18 | not applicable | 0.8250 | 0.8500 | 0.6563 | 16/16 | 0 | 0.0539 |
| Synthetic seed | 0.20 | not applicable | 0.8250 | 0.8500 | 0.6563 | 16/16 | 0 | 0.0539 |
| Synthetic seed | 0.25 | not applicable | 0.8250 | 0.8500 | 0.6563 | 16/16 | 0 | 0.0539 |
| Thriller fixture | 0.00 | fail | 0.7000 | 0.5000 | 0.4375 | 16/16 | 0 | 0.6319 |
| Thriller fixture | 0.10 | fail | 0.9000 | 0.7000 | 0.4375 | 16/16 | 0 | 0.6238 |
| Thriller fixture | 0.15 | fail | 0.8500 | 0.7000 | 0.4375 | 16/16 | 0 | 0.6245 |
| Thriller fixture | 0.18 | pass | 0.8500 | 0.7000 | 0.4375 | 16/16 | 0 | 0.6232 |
| Thriller fixture | 0.20 | pass | 0.8500 | 0.7000 | 0.4375 | 16/16 | 0 | 0.6232 |
| Thriller fixture | 0.25 | pass | 0.8500 | 0.7000 | 0.4375 | 16/16 | 0 | 0.6228 |

### Selection rule and chosen weight

1. Acceptance guard: with the thriller persona and `edge-lighthearted-girlfriend`, all 4 picks are Comedy and at least 3 carry Romance, Family or Animation with at least one Romance.
2. Among weights that pass the guard, choose the smallest boost whose holdout mood precision is within 0.01 of the maximum holdout precision in that guard-passing set and that does not reduce tune precision, non-mood soft precision or non-empty constraint satisfaction versus the no-boost baseline, or increase empty results.
3. Ties choose the smaller boost, because less taste override is preferred.

The rule evaluates the thriller persona, the persona named by the acceptance guard; the synthetic persona is reported for comparison only.

Guard-passing weights: 0.18, 0.20, 0.25. Maximum holdout mood precision among them: 0.7000.

Chosen boost: **0.18**. Shipped `MOOD_BOOST_WEIGHT`: 0.18 (matches).

### Reported case at the chosen weight

Thriller persona, `edge-lighthearted-girlfriend`, boost 0.18:

| Rank | movieId | Title | Genres |
| --- | --- | --- | --- |
| 1 | 1238440 | Ditched | Drama, Comedy, Thriller |
| 2 | 284 | The Apartment | Comedy, Drama, Romance |
| 3 | 3078 | It Happened One Night | Comedy, Romance |
| 4 | 164848 | All About You | Comedy, Romance |

Reported ids: 1238440, 284, 3078, 164848.

Result: 3/4 carry a warm genre, 3 carry Romance; guard passes.

The harness embeds this prompt one at a time, exactly as the route does. The DB regression in `prompt-filter.test.ts` follows the same single-prompt path against the current catalog snapshot and pins these ids and their order.

### No-mood guard

- Synthetic seed: non-mood soft precision is 0.6563–0.6563 across boost weights (unchanged, as required).
- Thriller fixture: non-mood soft precision is 0.4375–0.4375 across boost weights (unchanged, as required).

## Findings

- Parser: 35/35 cases match exactly (100.0%).
- Constraint satisfaction across non-empty filtered cases ranges 1.0000–1.0000; empty results range 0–0 per weight pair.
- Genre precision@4: hard-filter cases 0.9885–0.9923, soft cases 0.5250–0.8000.
- Taste similarity (diagnostic) ranges -0.0152–0.0860 against the fixed synthetic persona.
- Mood: the pre-declared rule selects 0.18; the reported thriller case passes the guard at that weight, and non-mood soft cases are unchanged across the sweep.

### Recommendation

Decision rule: propose a change only when a pair beats 0.50 / 0.50 in soft genre precision by at least 0.02, does not reduce non-empty constraint satisfaction, does not increase empty results, and loses no more than 0.02 hard-case genre precision.

Evidence supports moving toward 0.80 / 0.20: soft genre precision is 0.8000 versus 0.6909 at 0.50 / 0.50, with non-empty constraint satisfaction 100.0% and 0 empty results. This step does not change production weights; the value is a follow-up candidate.

## Caveats

- The set is small (35 hand-labelled prompts) and the genre labels are an authored interpretation, not an objective ground truth.
- The synthetic and thriller taste vectors are fixed deterministic personas, not real users; taste similarity is a diagnostic, not evidence about personalization.
- Mood labels are authored and only two holdout mood cases exist. The chosen weight is evidence-backed on that small sample and must be retuned when more holdout cases are added.
- One deterministic run, no confidence intervals or significance test. Differences below the 0.02 materiality margin are treated as noise.
- Hard-filter cases are partly guaranteed by the filter itself; their genre precision checks the filter/rank interaction, not semantic understanding.
- Controls have no genre labels; they exercise the taste/ordering path only.
- The catalog is the local 2026 snapshot and the embedding model is pinned; another snapshot can change which films compete for four slots.

