# How we evaluated the recommender, and what it taught us (Nov 2026)

This is the human-readable story of the evaluation ticket: what question we
asked, how we answered it, what the numbers said (including the parts that
stung), and what we changed as a result. The generated reports with the exact
tables live in `docs/evaluation-2026-11-23.md` (baseline) and
`docs/evaluation-experiments-2026-11-23.md` (experiments); the harness itself
is `apps/api/src/evaluation/`, runnable with `npm run evaluate:ranking`.

## The question

By November 2026 the recommender had several ranking dials set by feel:

- a **quality tilt** (well-received films rank higher among comparable taste
  matches), raised once from 0.05 to 0.12 because picks "felt too obscure";
- equal 50/50 **prompt/taste weighting**;
- a **diversity penalty** so the four picks aren't four versions of the same
  film;
- **exploration** (the "Surprise me" dial), shipped at an interim 0.5.

Every one of those was a guess. The backlog's evaluation ticket existed to
replace guesses with evidence: *does our ranking actually find films people
liked, better than dumb alternatives?*

## How you measure a recommender offline

The classic approach, and the one we used:

1. **Get real users with real ratings.** The old Kaggle MovieLens dataset ships
   26M ratings; we deliberately started with its small slice — 100,004
   ratings from 671 people — for fast iteration. `links.csv` translates
   MovieLens film ids into TMDB ids, which is how their ratings attach to our
   live 40,000-film catalog.
2. **Split each user's history by time.** The oldest 80% of a person's ratings
   become their "training" data — exactly what the app would use to build their
   taste vector. The newest 20% are hidden ("held out") and treated as films
   they turned out to like (rating >= 4 counts as a like).
3. **Pretend to be the app.** For each user: build a taste vector from their
   training ratings using the same production code the API uses, rank the
   catalog, and ask: *did any held-out likes end up near the top?*
4. **Score with standard retrieval metrics.** Recall@4 (did we surface *any*
   held-out like in the four delivered picks?), NDCG@4 (how high did they
   land?), MRR (how quickly does the first hit appear?). These are tiny
   numbers by nature — you are fishing for one specific film out of ~30,000
   eligible ones — so what matters is the **comparison**, not the absolutes.
5. **Compare against baselines anyone can build**: rank everything by raw
   popularity, and rank by genre match. If our taste engine can't beat those,
   its embeddings aren't earning their electricity.

## Coverage reality check

Only 24.6% of our catalog is reachable through MovieLens links (9,847 of
40,000 films — MovieLens tracks older, mostly English-language cinema). 85% of
the rating rows mapped into the catalog. Every number below is therefore about
the linked subset of the catalog; post-2017 films can never be "relevant"
because the ratings stop in 2017. Small, dated, skewed — but real people and a
real signal.

## The baseline result (the sting)

| Strategy | Recall@4 | NDCG@4 | MRR |
|---|---|---|---|
| **Our production ranking** | 0.0028 | 0.0068 | 0.0218 |
| Popularity (vote count) | **0.0082** | **0.0195** | **0.0579** |
| Genre match | 0.0046 | 0.0132 | 0.0374 |

**We lost. To both baselines.** Raw popularity found people's held-out likes
three times better than our taste engine. Even simple genre matching beat us.
Two honest footnotes: our MRR was initially measured only over the 4 delivered
picks while baselines scanned 100 deep (fixed in the experiments — it narrowed
the gap, it did not close it), and "exclude everything the user has seen"
would make the metric structurally zero, so held-out films stay rankable by
design.

## Why we were losing

The diagnosis: **popularity entered our pipeline too late.** The candidate pool
(the ~50 films the ranker considers) is selected by pure embedding similarity;
the quality tilt only reorders *within* that pool. MovieLens users' held-out
likes skew heavily toward well-known films, so by the time our tilt could act,
the popular films were often never in the pool to begin with.

The experiments isolated each lever, one variable at a time, on the same users
and splits:

1. **Deeper pools (50 → 500):** recall barely moved. Retrieval depth was not
   the bottleneck.
2. **Tilt applied at the pool stage:** tiny gains; moving it there *instead of*
   the rerank collapsed performance. The rerank is where it belongs.
3. **The tilt weight sweep — the headline:** performance rose monotonically
   from 0.05 through 0.12, 0.25, 0.50. It had not saturated.

| Tilt weight | Recall@4 | vs genre baseline |
|---|---|---|
| 0.05 | 0.0017 | loses |
| 0.12 (our value) | 0.0028 | **loses** |
| 0.25 | 0.0055 | wins |
| 0.50 | 0.0068 | wins clearly |
| popularity itself | 0.0082 | — |

## The trap the metric sets, and the line we chose

Here is the uncomfortable truth: the sweep would keep rising past 0.50. At
tilt -> infinity our ranker *becomes* the popularity baseline and "wins" the
metric completely. But this product's stated point is surfacing films you'd
love that you haven't heard of — a ranker that just returns famous films is a
metric victory and a product failure. MovieLens-style held-out evaluation
structurally rewards genericness, because people's logged likes skew popular.

So the honest framing was never "beat popularity". It was: **beat the genre
baseline decisively, approach popularity's retrieval, and stay a taste-driven
ranker.** Tilt 0.50 does exactly that: ~80% of popularity's recall, clearly
ahead of genre, with the pool still selected by taste. The product owner
approved 0.50, and it was pinned in the backlog (application requires
recomputing the test fixtures that pin the old arithmetic, which is being done
as its own careful step).

## What each shipped change actually meant

- **0.12 -> 0.50 quality tilt:** well-received films can now reorder candidates
  within ~0.5 cosine similarity of each other. A clearly better taste match
  still wins (the invariant test fixtures were widened so this stays true and
  *tested*).
- **IMDb rating/votes columns:** imported as evaluation-only signals
  (never exposed through the API), so future evaluation rounds can test
  whether IMDb reception beats TMDB reception as a tilt source.
- **The harness itself:** committed and deterministic — any future ranking
  change can be re-evaluated in minutes instead of argued about.

## What we did NOT change, and why

- **Soft mood boosts** ("edge of my seat" -> thrillers) stay deferred: this
  harness evaluates rating-based ranking; it has no held-out data for prompt
  behavior, so tuning prompts would be guesswork again — the exact thing this
  ticket exists to stop.
- **A minimum-vote floor** on candidates would likely help the metric further,
  but it collides with the architecture's "never an eligibility gate" rule and
  the product's obscure-films goal. It is a conscious non-decision.
- **Pool 50 stays** the served pool size: deeper pools bought almost nothing.

## Caveats to keep in mind when quoting these numbers

658 evaluated users, 2017-era ratings against a 2026 catalog, 24.6% catalog
coverage, no confidence intervals, baselines untuned. Directional truth, not
precision. The value of the exercise is not the decimals — it is that the
ranking conversation moved from "feels obscure" to "here is the curve, here is
the trade-off, here is the point we chose on it".
