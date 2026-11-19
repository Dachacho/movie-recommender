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
Candidate seed: https://huggingface.co/datasets/RobinMillford/movie-embeddings-rag-db (reported 7,733 movies, 384-dimensional MiniLM vectors). Before adoption, inspect actual files, IDs, metadata, license and upstream rights, duplicates, vector norms and model/preprocessing provenance. These claims have not yet been independently verified in this implementation. Use TMDB for missing metadata/movies subject to its terms. Generate new vectors locally using @huggingface/transformers and compatible MiniLM weights, pooling and normalization. If compatibility cannot be demonstrated, re-embed the catalog consistently rather than mixing vector spaces. Load model once, cache it, batch ingestion; prompt inference only when needed.

## Schema (provisional until seed inspection)
- movies: id PK, tmdb_id nullable unique, title, release_year, overview, runtime, genres, keywords, director, cast, poster_path, popularity nullable, vote_average nullable, vote_count nullable, embedding vector(384), embedding_version. Popularity and vote fields are used for evaluation and display only, never as an eligibility gate. Resolve missing external IDs before linking; do not assume seed IDs are TMDB IDs.
- users: id PK, email unique, taste_vector nullable, initial_preferences.
- user_movies: user_id + movie_id composite PK, rating nullable (0.5–5 in half-star increments), watched_at nullable.
- watchlist: user_id + movie_id composite PK, added_at.
- cooldowns: user_id + movie_id composite PK, expires_at.
- lists: id PK, source_url nullable, movie_ids array; add ownership if persisting private lists.
Guest ratings, watched IDs, watchlist, cooldowns, taste and history live in IndexedDB. Guest cooldowns are enforced client-side and sent as validated `excludeIds`. The only guest payload sent to the server is the ratings input to the stateless `POST /taste`; it is never logged or persisted. Account history persistence can be added when accounts are implemented. Guest export protects against browser eviction. All users share the movie catalog.

## Recommendation algorithm
1. Taste vector = normalize(sum(movie_embedding * (rating - 2.5))). Ignore unrated movies. Handle zero/near-zero norm with a cold-start fallback.
2. Parse explicit constraints (e.g. runtime, year, genre when unambiguous) into structured filters. Use local embedding for semantic mood text. Keep transient intent separate from persistent taste. Combine normalized taste and prompt vectors with configurable weights; start at equal weighting when both exist and test. If neither exists, use a varied cold-start selection.
3. Filter eligible catalog by source, watched IDs, cooldowns and hard constraints before ranking. Use cosine similarity via pgvector. Exact search is sufficient for the initial catalog; benchmark before adding ANN indexes.
4. Select best candidate, then rerank alternatives for diversity using a simple similarity penalty. Exploration relaxes taste ranking, never hard filters. Do not gate by community rating.
5. Return up to four real movies. Single replacement excludes the other visible picks and the rejected pick; full refresh excludes all replaced picks. Persist cooldowns for seven days. Recalculate taste after rating changes.

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
