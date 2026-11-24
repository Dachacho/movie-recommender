# Architecture

## Stack
Node 24 LTS + TypeScript 6.0.x, Express, React + Vite, PostgreSQL 17 + pgvector, Drizzle, Zod, Dexie/IndexedDB, vite-plugin-pwa, Vitest, Docker Compose, npm workspaces. Keep TypeScript on 6.0.x until typescript-eslint supports 7. ESLint and Prettier are the lint and format gates. Modular monolith; no Redis, separate vector database, Python service or paid inference. Local development is free; hosting and commercial data rights are separate concerns. Docker Compose runs PostgreSQL 17 with pgvector on port 5432 and enables the vector extension at initialization; `.env.example` holds non-secret local defaults.

## Layout
```
apps/api/src/{modules,db,middleware}/
apps/web/src/
packages/shared/
db/init/
docker-compose.yml
PRODUCT.md
ARCHITECTURE.md
AGENTS.md
BACKLOG.md
```
API modules: movies, embeddings, recommendations, imports, users. Keep ranking math pure and testable. Shared request/response schemas belong in packages/shared.

## Frontend
Plain CSS and React Router. No component library, state library or E2E framework. Component tests use Vitest with Testing Library and jsdom.

## Catalog
Seed: https://www.kaggle.com/datasets/rounakbanik/the-movies-dataset, a TMDB snapshot of 45,466 films with 26M MovieLens ratings; see `docs/seed-inspection.md` for verified counts and defects. Movie IDs are TMDB IDs; `links.csv` maps MovieLens IDs to them. Coverage is overview 97.9%, runtime 99.4%, poster 99.2%, with a handful of malformed and duplicated IDs to clean at import.

The catalog is imported from alanvourch's Kaggle "TMDB daily updates" export (2026-11-21 snapshot): keep Released rows that have an overview, a positive runtime and a finite popularity, then take the top 40,000 by popularity with an id tie-break. Popularity is a curation-at-import signal only, never an eligibility gate at recommendation time. Importing the full catalog (~1.3M rows) is deferred to productionization; see `docs/catalog-snapshot-2026.md` for provenance, verified counts and licenses.

Kaggle labels the set CC0, but the data is TMDB and GroupLens content. TMDB terms forbid caching beyond six months, dataset collection for ML, and commercial use without an agreement; GroupLens permits research use only. Use it for the local, non-commercial MVP, and treat a public or commercial launch as requiring licensing or a different catalog. The newer export carries the same caveat: its Apache-2.0 label is Kaggle's, not TMDB's, and the terms above still apply.

Embeddings are not included. Generate 384-dimensional MiniLM vectors locally with @huggingface/transformers from overview, tagline, keywords and genres. Pin the weights to a specific model revision, choose the quantization deliberately, and record the model, revision, quantization, pooling and normalization in embedding_version, so a later re-embed can be told apart from the current vectors. Load the model once, embed the catalog in batches, and use the same model and normalization for prompt text. Keep the ratings file out of the application database and use it only for offline evaluation. Store TMDB poster paths, never full URLs.

## Schema
- movies: id PK (TMDB ID), title, release_year, overview, tagline, runtime, genres, keywords, director, cast, poster_path, popularity nullable, vote_average nullable, vote_count nullable, imdb_rating nullable, imdb_votes nullable (evaluation-only, never exposed via the API), embedding vector(384), embedding_version. Popularity and vote fields are used for evaluation and display only, never as an eligibility gate. `links.csv` maps MovieLens IDs to `id`; do not infer IDs from titles.
- users: id PK, email unique, taste_vector nullable, initial_preferences.
- user_movies: user_id + movie_id composite PK, rating nullable (0.5–5 in half-star increments), watched_at nullable.
- watchlist: user_id + movie_id composite PK, added_at.
- cooldowns: user_id + movie_id composite PK, expires_at.
- lists: id PK, movie_ids array; add ownership if persisting private lists.
Guest ratings, watched IDs, watchlist, cooldowns, taste and history live in IndexedDB. Guest cooldowns are enforced client-side and sent as validated `excludeIds`. Rating a film implies it has been seen: the client unions rated ids with watched ids in `excludeIds`, so nothing the guest has rated is picked again. The server only ever receives transient per-request inputs: the ratings input to the stateless `POST /taste`, the id arrays and vectors in `POST /recommendations`, and catalogue lookups by movie id such as `GET /movies/:id`. None of them are logged or persisted, and no guest profile is stored server-side. Account history persistence can be added when accounts are implemented. Guest export protects against browser eviction. All users share the movie catalog.

## Recommendation algorithm
1. Taste vector = normalize(sum(movie_embedding * (rating - 2.5))). Ignore unrated movies. Handle zero/near-zero norm with a cold-start fallback.
2. Parse explicit constraints (e.g. runtime, year, genre when unambiguous) into structured filters. Use local embedding for semantic mood text. Keep transient intent separate from persistent taste. Combine normalized taste and prompt vectors with configurable weights; start at equal weighting when both exist and test. If neither exists, use a varied cold-start selection.
3. Filter eligible catalog by source, watched IDs, cooldowns and hard constraints before ranking. Use cosine similarity via pgvector. Exact search is sufficient for the initial catalog; benchmark before adding ANN indexes.
4. Select best candidate, then rerank alternatives for diversity using a simple similarity penalty. Exploration changes candidate-pool composition, never hard filters: at strength e, `round(e * poolSize)` of the pool comes from a deep similarity band starting at rank 500 (ten pool lengths beyond the near band) and the rest from the top, so the rerank can pick films outside the usual taste. "Surprise me" sends an interim 0.5 (half near-taste, half deep-band) pending held-out evaluation; 0 keeps today's top pool, and candidate lists with fewer rows than rank 500 plus the required deep count degrade to the top pool. Do not gate by community rating.
5. Return up to four real movies. Single replacement excludes the other visible picks and the rejected pick; full refresh excludes all replaced picks. Persist cooldowns for seven days. Recalculate taste after rating changes.
6. A reception tilt breaks ties toward better-received films: relevance = similarity + 0.50 * (0.7 * vote-average/10 + 0.3 * log-scaled vote count). The weight was raised from 0.12 on the held-out evidence in docs/evaluation-experiments-2026-11-23.md (monotone tilt sweep; 0.50 beat the genre baseline on every metric). Within the similarity-retrieved pool this is meaningfully reception-steered: candidates within ~0.50 cosine similarity can be reordered by reception, though taste and exploration select the pool and larger gaps still win. It is an interim, product-approved value, never an eligibility gate, and must be retuned against held-out evaluation evidence.

Evaluate with deterministic unit tests and held-out ratings; tune weights only after inspecting actual results. A single centroid may dilute distinct tastes; clustering is explicitly deferred.

## API
- GET /movies/search?q=...; GET /movies/:id
- POST /imports/letterboxd (CSV upload, matched/unmatched report); POST /imports/list (CSV or pasted list contents; no URL fetching in the MVP)
- POST /taste (movie IDs and ratings -> vector or null; stateless, payload never logged or persisted)
- POST /recommendations (source, optional prompt, tasteVector, candidateIds, excludeIds, exploration, limit 1–4)
- GET /me; PATCH /me/movies/:id; GET /me/watchlist; GET /me/stats; POST /me/migrate (account phase)

For guests validate all client input including finite 384-d vectors and bounded ID arrays; for accounts derive profile and exclusions server-side. Limit upload sizes, validate CSV, rate-limit public inference/import endpoints, avoid arbitrary URL fetching. No raw SQL interpolation. Return structured errors and explicit empty results. Authentication is deferred; select a solution before exposing account endpoints.

## Implementation order
Catalog and DB -> taste and ranking -> recommendation API -> minimal UI -> imports and persistence -> replacement and exploration -> dashboard/PWA -> optional accounts. Test end-to-end early using a small fixture, then the real dataset.
