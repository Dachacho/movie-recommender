# Prompt evaluation — labelled natural-language set

Offline harness output for `npm run evaluate:prompt`. It scores the committed parser and ordering path. The harness does not modify production weights (0.5/0.5); parser coverage was widened in this step for the initial misses documented in the parser audit.

## Setup and provenance

- Catalog: 40,000 films in local Postgres, 40,000 with an embedding.
- Embedding model: `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9`, dtype `q8`, mean pooling, normalized; embedding version `all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9/q8/mean/normalized/1`.
- Synthetic taste vector: deterministic 384-d unit vector from mulberry32 seed `0x5eed1a57`. It is not a real user and no guest data is read.
- Retrieval: production `recommendMovies` path (top-500 cosine buffer, quality tilt, diversity rerank), limit 4, exploration 0, filters from `parsePromptConstraints`.
- Prompt texts are embedded in one batch. Weights are passed explicitly to `combineQueryVector`; production `PROMPT_WEIGHT`/`TASTE_WEIGHT` remain 0.5/0.5.
- The harness only reads the catalog and embeddings (no writes, no whole-profile load, no server).

## Dataset

Hand-labelled prompts. Expected filters are exactly what the existing filter schema can express; genre weights are graded relevance for what the prompt semantically asks for.

| Group | Cases | With expected filters | With genre weights |
| --- | --- | --- | --- |
| explicit | 7 | 7 | 5 |
| soft | 8 | 0 | 8 |
| edge | 11 | 8 | 8 |
| control | 6 | 0 | 0 |
| **total** | **32** | **15** | **21** |

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

This exact prompt previously parsed to no filters, so a thriller-leaning taste pulled thriller/crime/horror picks. Added "lighthearted", "light-hearted" and "light hearted" as Comedy synonyms in the existing Comedy pattern. "Girlfriend" remains date context only: no Romance hard filter, and Romance stays a 0.5 graded label for this case. The taste blend remains 0.50/0.50.

Follow-up hardening: "not only" is treated as inclusion; contractions (don't/dont, didn't, doesn't, wouldn't, won't) and "anything but"/"all but" are treated as negation; and range, directional and trailing runtime bounds now compete by mention index, with the existing first-bound-wins rule resolving contradictions.

Production retrieval still uses parser output, so these fixes directly change which filters are sent for the affected prompts.

## Metrics

- `parseAccuracy`: exact deep equality between `parsePromptConstraints` and the labelled `expectedFilters` for every case.
- `constraintSatisfaction`: fraction of cases with expected filters whose every returned pick satisfies genre OR, year bounds and runtime bounds. An empty result is vacuously true; the non-empty variant is reported beside it.
- `genrePrecision@4`: per pick, the maximum weight among its genres (0 when none match); per case, the mean over returned picks (0 for an empty result); then the mean over cases. Reported for all labelled cases, hard-filter cases and soft cases separately.
- `tasteSimilarity@4`: mean cosine between returned picks and the fixed synthetic taste vector, over cases that returned picks. Diagnostic only.
- Empty-result counts are reported per weight pair because filtering can exhaust a pool.

## Parse coverage

Parse accuracy: 32/32 (100.0%).

No parse misses.

## Weight sweep

All five weight pairs use the same prompts, batch embeddings and synthetic taste vector. Only the combination weights change.

| Prompt / taste | Constraint satisfaction | Non-empty satisfaction | Empty results | Genre precision@4 all | Hard | Soft | Taste similarity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.35 / 0.65 | 15/15 (100.0%) | 15/15 | 0 | 0.7690 | 0.9923 | 0.4063 | 0.0951 |
| 0.50 / 0.50 | 15/15 (100.0%) | 15/15 | 0 | 0.8869 | 0.9923 | 0.7156 | 0.0589 |
| 0.65 / 0.35 | 15/15 (100.0%) | 15/15 | 0 | 0.8821 | 0.9923 | 0.7031 | 0.0297 |
| 0.80 / 0.20 | 15/15 (100.0%) | 15/15 | 0 | 0.8667 | 0.9885 | 0.6688 | 0.0028 |
| 1.00 / 0.00 | 15/15 (100.0%) | 15/15 | 0 | 0.8905 | 0.9923 | 0.7250 | -0.0153 |

## Findings

- Parser: 32/32 cases match exactly (100.0%).
- Constraint satisfaction across non-empty filtered cases ranges 1.0000–1.0000; empty results range 0–0 per weight pair.
- Genre precision@4: hard-filter cases 0.9885–0.9923, soft cases 0.4063–0.7250.
- Taste similarity (diagnostic) ranges -0.0153–0.0951 against the fixed synthetic persona.

### Recommendation

Decision rule: propose a change only when a pair beats 0.50 / 0.50 in soft genre precision by at least 0.02, does not reduce non-empty constraint satisfaction, does not increase empty results, and loses no more than 0.02 hard-case genre precision.

Keep 0.50 / 0.50. The best alternative (1.00 / 0.00) changes soft genre precision by +0.0094, which does not clear the 0.02 materiality margin while holding the constraint, empty-result and hard-case guards.

## Caveats

- The set is small (32 hand-labelled prompts) and the genre labels are an authored interpretation, not an objective ground truth.
- The synthetic taste vector is a fixed deterministic direction, not a real user; taste similarity is a diagnostic, not evidence about personalization.
- One deterministic run, no confidence intervals or significance test. Differences below the 0.02 materiality margin are treated as noise.
- Hard-filter cases are partly guaranteed by the filter itself; their genre precision checks the filter/rank interaction, not semantic understanding.
- Controls have no genre labels; they exercise the taste/ordering path only.
- The catalog is the local 2026 snapshot and the embedding model is pinned; another snapshot can change which films compete for four slots.
- No soft mood boost was added. Soft prompts are measured through semantic embedding similarity only.

