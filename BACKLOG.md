# Backlog

## To do
- [ ] Installable PWA: vite-plugin-pwa@2.0.0 (Vite 8 peer, Node ≥20.19, build-time only) with a manifest, 192/512 icons plus apple-touch-icon, and app-shell precache only — no `/api` or TMDB image caching. Deferred by decision while the responsive site ships; PRODUCT.md still requires installability.
- [ ] Optional accounts, authentication and guest migration.
- [ ] For discussion: clustered taste — replace the single average taste vector with 2–3 clusters of the guest's rated films (e.g. the horror + animation case), ranking within the cluster tonight's prompt/mood points at. ARCHITECTURE already flags the single-centroid dilution; the evaluation harness can compare per-cluster vs single centroid on held-out likes. Decide after a short experiment round.
- [ ] Soft mood boosts (suggestive phrases like "edge of my seat" nudging genres without hard filters): deferred until there is an evaluation path for prompt behavior — the ratings-based harness cannot evidence prompt tuning, and guessing is what the evaluation ticket retired.
- [ ] Grow the catalog through imports: resolve unmatched films via the live TMDB API and embed + insert them (needs a free TMDB API key and a runtime internet dependency; separate decision on catalog drift vs the curated 40k).

## Doing

## Done
- [x] Add dashboard, history and profile export/delete. (Guest history recorded per round with a movie snapshot; `#picks`/`#dashboard` navigation; dashboard with counts, mean, half-star histogram, rated/watchlist removals and a recent-picks ledger; Letterboxd-compatible ratings CSV that skips unlookupable films, versioned JSON backup validated on parse, and a two-step delete-all in one IndexedDB transaction. Data-handling rule amended to name transient catalogue lookups by movie id. PWA half split into its own ticket and deferred by decision.)
- [x] Evaluate ranking against held-out ratings and baselines; tune if needed. (Harness shipped, deterministic, production-path parity; baseline showed production trailing popularity AND genre; experiments isolated pool size, pool-stage tilt and the tilt sweep; approved outcome applied: QUALITY_TILT_WEIGHT 0.50, parity-verified Recall@4 0.0028 → 0.0068. IMDb evaluation columns adopted, API-unexposed. Narrative: docs/evaluation-explained-2026-11-24.md. Soft mood boosts deferred to their own ticket.)
- [x] Implement list mode with permitted input methods, individual replacement, full refresh, cooldown and exploration. (Four sources: catalog, watchlist, rewatch shortlist rated 4.0+, pasted lists; per-pick replacement with seven-day cooldowns, atomic batch writes, action-time exclusions, and trim notices; exploration 0-1 — later redesigned to pool composition with a deep similarity band, Surprise me sends interim 0.5.)
- [x] Import Letterboxd CSV with matching report; resolve missing movies through TMDB and compatible embeddings. (MVP shipped: match-only against the catalog with a matched/unmatched report, ratings.csv and watches.csv, rated rows imply seen. TMDB resolution for unmatched films split into the catalog-growth ticket.)
- [x] Add IndexedDB guest profile, ratings, watched state and watchlist. (Dexie-backed, Zod-validated; ratings power the stateless /taste flow, watched ids excluded from picks; library UI with half-star ratings and toggles.)
- [x] Parse explicit prompt constraints (genre, runtime, era keywords) into hard filters; soft genre boost for suggestive phrases. (Hard filters shipped; soft boosts deferred to the evaluation ticket so tuning uses evidence, not guesses.)
- [x] Re-import a fresher TMDB snapshot: fixes the ~93% dead poster paths found in sampling and covers post-2017 films; re-clean malformed/duplicate IDs, re-embed the whole catalog with the pinned model, re-verify counts. (2026-11-21 alanvourch export, top-40k by popularity; 40,000 rows verified, posters live, checksums stable across runs.)
- [x] Poster fix: sample-verify stored poster paths against image.tmdb.org, then render a graceful placeholder on broken images; decide whether a fresher snapshot re-import is needed. (Sampling: 28/30 dead; re-import ticket added.)
- [x] Build minimal recommendation screen: main pick, alternatives, optional prompt.
- [x] Initialize npm workspaces, Express, React/Vite, shared TypeScript configuration, Vitest and Docker Compose PostgreSQL/pgvector.
- [x] Inspect seed dataset: schema, license/provenance, IDs, coverage, model compatibility; document findings and decide whether to adopt or re-embed.
- [x] Create movie schema/migrations and idempotent seed importer; verify row counts, duplicates and vector dimensions.
- [x] Implement pure taste vector calculation and tests (positive/negative ratings, zero norm, invalid input).
- [x] Implement pgvector search, hard filters, diversity and cold-start fallback; test against fixtures.
- [x] Expose recommendation API and movie search; add validation and integration tests.
