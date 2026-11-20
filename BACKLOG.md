# Backlog

## To do
- [ ] Expose recommendation API and movie search; add validation and integration tests.
- [ ] Build minimal recommendation screen: main pick, alternatives, optional prompt.
- [ ] Add IndexedDB guest profile, ratings, watched state and watchlist.
- [ ] Import Letterboxd CSV with matching report; resolve missing movies through TMDB and compatible embeddings.
- [ ] Implement list mode with permitted input methods, individual replacement, full refresh, cooldown and exploration.
- [ ] Evaluate ranking against held-out ratings and baselines; tune if needed.
- [ ] Add dashboard, history, profile export/delete and PWA installation.
- [ ] Optional accounts, authentication and guest migration.

## Doing

## Done
- [x] Initialize npm workspaces, Express, React/Vite, shared TypeScript configuration, Vitest and Docker Compose PostgreSQL/pgvector.
- [x] Inspect seed dataset: schema, license/provenance, IDs, coverage, model compatibility; document findings and decide whether to adopt or re-embed.
- [x] Create movie schema/migrations and idempotent seed importer; verify row counts, duplicates and vector dimensions.
- [x] Implement pure taste vector calculation and tests (positive/negative ratings, zero norm, invalid input).
- [x] Implement pgvector search, hard filters, diversity and cold-start fallback; test against fixtures.
