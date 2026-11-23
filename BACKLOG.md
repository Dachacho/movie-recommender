# Backlog

## To do
- [ ] Grow the catalog through imports: resolve unmatched films via the live TMDB API and embed + insert them (needs a free TMDB API key and a runtime internet dependency; separate decision on catalog drift vs the curated 40k).
- [ ] Evaluate ranking against held-out ratings and baselines; tune if needed. (Bundled: adopt the snapshot's imdb_rating/imdb_votes as an evaluation signal in the same schema migration. certification_us rejected for display; the snapshot has no adult flag to curate on. Retune the interim quality-tilt weights from the reranker: 0.12 tilt, 0.7/0.3 rating-dominant vote blend, log scale 6 — user reports unfamiliar films still surfacing; decide the right dial value with evidence, and discuss whether a minimum-vote threshold is acceptable given the architecture's no-eligibility-gate rule.)
- [ ] Add dashboard, history, profile export/delete and PWA installation.
- [ ] Optional accounts, authentication and guest migration.

## Doing

## Done
- [x] Implement list mode with permitted input methods, individual replacement, full refresh, cooldown and exploration. (Four sources: catalog, watchlist, rewatch shortlist rated 4.0+, pasted lists; per-pick replacement with seven-day cooldowns, atomic batch writes, action-time exclusions, and trim notices; exploration 0-1 scales taste similarity, Surprise me sends interim 0.5.)
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
