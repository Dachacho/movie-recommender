# Movie Recommender

One good pick, three varied alternatives, no endless scrolling.

A local-first movie recommender built on a 44,258-film catalog. It combines your
ratings into a taste vector, searches the catalog by embedding similarity,
reranks the alternatives for variety, and keeps guest data in the browser.

The backend and catalog are working. The React UI is still a placeholder — see
[Status](#status).

## Stack

- Node.js 24, TypeScript 6 (strict), ESM
- Express 5, Zod, Drizzle ORM
- PostgreSQL 17 + pgvector (Docker Compose)
- React 19 + Vite (plain CSS, no component library)
- Vitest for unit and integration tests
- npm workspaces: `apps/api`, `apps/web`, `packages/shared`

## Requirements

- Node.js >= 24
- Docker with Compose (for PostgreSQL/pgvector)
- About 3 GB of free disk: dataset archive ~230 MB, extracted CSVs ~1.1 GB,
  MiniLM model ~25 MB, and the imported catalog.

## Quick start

```sh
npm install
cp .env.example .env
npm run db:up          # PostgreSQL 17 + pgvector on localhost:5432
npm run db:migrate     # creates the movies table and the vector extension
```

`db:up` returns before the container's healthcheck passes. If the migration runs
too early, wait for `docker compose ps` to show `healthy` and run it again.

### 1. Import the catalog

Download the Kaggle dataset
[`rounakbanik/the-movies-dataset`](https://www.kaggle.com/datasets/rounakbanik/the-movies-dataset)
and extract it. You only need `movies_metadata.csv`, `credits.csv` and
`keywords.csv`.

```sh
npm run catalog:import -- --data-dir /path/to/extracted
npm run catalog:verify
```

The first import downloads the pinned `all-MiniLM-L6-v2` int8 model (~25 MB) to
`apps/api/.cache/transformers`. A full run embeds 44,258 films and takes roughly
30 minutes on CPU. For a smaller development catalog:

```sh
npm run catalog:import -- --data-dir /path/to/extracted --limit 2000
```

`catalog:verify` reports the total rows, embedded rows, wrong-dimension vectors
and rows without a release year. Imports are idempotent: re-running them upserts
on the TMDB id.

### 2. Run it

```sh
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173
```

```sh
curl -s http://localhost:3000/health
# {"status":"ok"}
```

The web app does not call the API yet and there is no CORS or Vite proxy
configured, so browser requests from `:5173` will be blocked until the UI ticket
wires that up.

## Commands

Run these from the repository root.

| Command | What it does |
|---|---|
| `npm run dev:api` | API with watch mode on port 3000 |
| `npm run dev:web` | Vite dev server on port 5173 |
| `npm run build` | Production build (web only; API/shared have no build step) |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run lint` | ESLint |
| `npm run format` / `format:check` | Prettier write / check |
| `npm test` | All workspace tests |
| `npm run db:up` / `db:down` | Start / stop PostgreSQL |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run catalog:import -- --data-dir … [--limit N]` | Import or refresh the catalog |
| `npm run catalog:verify` | Print catalog health |

Database tests skip unless `DATABASE_URL` is set. To run the whole suite against
the real database:

```sh
set -a; . ./.env; set +a
npm test
```

Run a single workspace or file:

```sh
npm test -w @movie-recommender/api
cd apps/api && npx vitest run src/modules/recommendations
```

## API

Base URL: `http://localhost:3000`. JSON only. Every error uses the same envelope;
`details` is optional and its shape depends on the code (Zod issues for
`invalid_request`, `{ "movieIds": [...] }` for `unknown_movie_ids`):

```json
{ "error": { "code": "invalid_request", "message": "…", "details": [] } }
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/movies/search?q=alien` | Case-insensitive title search (2–80 chars, 20 results) |
| `GET` | `/movies/:id` | One movie card |
| `POST` | `/taste` | Ratings → normalized taste vector, or `null` |
| `POST` | `/recommendations` | Up to four ranked movies plus a cold-start flag |

`GET /movies/search` responds with `{ "movies": [ …cards… ] }`.
`GET /movies/:id` responds with `{ "movie": { …card… } }`. Both use the card
shape below.

### Movie card

```json
{
  "id": 862,
  "title": "Toy Story",
  "releaseYear": 1995,
  "runtime": 81,
  "overview": "Led by Woody, Andy's toys…",
  "genres": ["Animation", "Comedy", "Family"],
  "director": "John Lasseter",
  "cast": ["Tom Hanks", "Tim Allen", "…"],
  "posterPath": "/rhIRbceoE9lR4veEXuwCC2wARtG.jpg",
  "voteAverage": 7.7
}
```

`posterPath` is a TMDB path, never a full URL. Use it with the TMDB image base
(`https://image.tmdb.org/t/p/w500`) subject to TMDB's terms.

`releaseYear`, `runtime`, `overview`, `director`, `posterPath` and `voteAverage`
are nullable; the catalog has films with missing metadata.

### Taste

```sh
curl -s -X POST http://localhost:3000/taste \
  -H 'content-type: application/json' \
  -d '{"ratings":[{"movieId":862,"rating":5},{"movieId":8844,"rating":1.5}]}'
```

- 1–500 unique ratings, 0.5–5 in half-star steps.
- Returns `{ "tasteVector": [ … 384 numbers … ] }` or `{ "tasteVector": null }`
  when the ratings cancel out or all sit at the 2.5 baseline.
- Unknown or unembedded movie ids return `400 unknown_movie_ids`.
- Stateless: nothing is stored or logged.

### Recommendations

```sh
curl -s -X POST http://localhost:3000/recommendations \
  -H 'content-type: application/json' \
  -d '{"source":"catalog","limit":4}'
```

```json
{ "movies": [ { "id": 862, "title": "Toy Story", "…": "…" } ], "coldStart": true }
```

- `source`: required; `catalog`, `watchlist` or `list`.
- `catalog` must omit `candidateIds`; `watchlist`/`list` require a non-empty
  `candidateIds` array (the client's local list).
- `candidateIds` and `excludeIds`: at most 10,000 unique ids each.
- `tasteVector`: optional 384-d vector, finite, `|value| ≤ 10`. Omit or send
  `null` for cold start.
- `excludeIds`: optional watched/cooldown ids.
- `limit`: required, 1–4.
- Bodies over 256 kB return `413 payload_too_large`.
- Popularity and vote counts are never eligibility gates.

The request does not accept the optional prompt or runtime/genre filters yet;
those arrive with the UI and prompt tickets.

## Project layout

```
apps/api/src/
  app.ts                 Express app and error handling
  server.ts              Bootstrap
  db/                    Drizzle schema, client, migration tests
  modules/movies/        Catalog import, parsing, search/detail routes
  modules/taste/         Pure taste-vector math + /taste route
  modules/recommendations/ Candidate query, diversity rerank, engine, route
apps/web/src/            React placeholder
packages/shared/         Zod request/response contracts
db/init/                 pgvector extension for Compose
docs/seed-inspection.md  Verified dataset findings, cleaning rules, license
```

## Data and license

The catalog is a 2017 TMDB snapshot distributed on Kaggle as *The Movies
Dataset*; see [`docs/seed-inspection.md`](docs/seed-inspection.md) for verified
counts, defects and cleaning rules.

Kaggle labels it CC0, but the content comes from TMDB and GroupLens and cannot be
relicensed:

- TMDB terms forbid caching beyond six months, dataset collection for ML, and
  commercial use without an agreement; attribution is required.
- GroupLens ratings are licensed for research use only.

Treat this project as a **personal, non-commercial MVP**. A public or commercial
launch needs TMDB licensing and GroupLens permission, or a different catalog.

The 26M MovieLens ratings are not imported into the application database. They
are kept for offline evaluation only. No catalog refresh exists yet, so the
catalog stops at 2017.

## Status

Working: catalog import and verification, movie search/detail, taste vectors,
pgvector ranking with filters, diversity reranking, cold start, and the HTTP API
with validation and integration tests.

Next, per [`BACKLOG.md`](BACKLOG.md): the recommendation screen, then IndexedDB
guest profiles and ratings, Letterboxd import, list mode with cooldowns, and
evaluation against held-out ratings.

Known gaps:

- Web UI is a placeholder; no CORS/proxy yet.
- No auth, rate limiting or server-side persistence; guest data is designed to
  live in IndexedDB.
- Letterboxd links need `imdb_id`, which is not imported yet.
- The request has no prompt/exploration/filter fields yet.
- Catalog refresh and incremental re-embedding are not implemented.

## More docs

- [`PRODUCT.md`](PRODUCT.md) — what the product must do
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — approved technical decisions
- [`BACKLOG.md`](BACKLOG.md) — implementation order and status
- [`AGENTS.md`](AGENTS.md) — workflow for coding agents
