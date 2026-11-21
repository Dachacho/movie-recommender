# Backlog

## To do
- [ ] Parse explicit prompt constraints (genre, runtime, era keywords) into hard filters; soft genre boost for suggestive phrases. Fixes literal matches like "Thriller" (the MJ video) for "sweaty thriller".
- [ ] Poster fix: sample-verify stored poster paths against image.tmdb.org, then render a graceful placeholder on broken images; decide whether a fresher snapshot re-import is needed.
- [ ] Re-import a fresher TMDB snapshot: fixes the ~93% dead poster paths found in sampling and covers post-2017 films; re-clean malformed/duplicate IDs, re-embed the whole catalog with the pinned model, re-verify counts.

- [ ] Add IndexedDB guest profile, ratings, watched state and watchlist.
- [ ] Import Letterboxd CSV with matching report; resolve missing movies through TMDB and compatible embeddings.
- [ ] Implement list mode with permitted input methods, individual replacement, full refresh, cooldown and exploration.
- [ ] Evaluate ranking against held-out ratings and baselines; tune if needed.
- [ ] Add dashboard, history, profile export/delete and PWA installation.
- [ ] Optional accounts, authentication and guest migration.

## Doing

## Done
- [x] Build minimal recommendation screen: main pick, alternatives, optional prompt.
- [x] Initialize npm workspaces, Express, React/Vite, shared TypeScript configuration, Vitest and Docker Compose PostgreSQL/pgvector.
- [x] Inspect seed dataset: schema, license/provenance, IDs, coverage, model compatibility; document findings and decide whether to adopt or re-embed.
- [x] Create movie schema/migrations and idempotent seed importer; verify row counts, duplicates and vector dimensions.
- [x] Implement pure taste vector calculation and tests (positive/negative ratings, zero norm, invalid input).
- [x] Implement pgvector search, hard filters, diversity and cold-start fallback; test against fixtures.
- [x] Expose recommendation API and movie search; add validation and integration tests.
