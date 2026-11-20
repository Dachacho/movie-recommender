# Seed dataset inspection

Backlog item: inspect seed dataset before schema and importer work.

## Decision

Adopt https://www.kaggle.com/datasets/rounakbanik/the-movies-dataset (Kaggle, "The Movies Dataset"): a TMDB metadata snapshot with 45,466 films and a separate MovieLens ratings file. It is the only inspected candidate that provides posters, overviews, runtime, genres, keywords, cast/crew, external IDs and held-out ratings together.

## Files verified

Downloaded through the Kaggle API (238,862,293-byte archive, about 1.1 GB extracted).

| File | Rows | Contents |
|---|---|---|
| `movies_metadata.csv` | 45,466 | 24 columns, TMDB movie IDs |
| `credits.csv` | 45,476 | JSON cast/crew; director extractable for 44,589 |
| `keywords.csv` | 46,419 | non-empty for 31,624 |
| `links.csv` | 45,843 | TMDB ID on 45,624, IMDb ID on 45,843 |
| `ratings.csv` | 26,024,289 | MovieLens 0.5–5 ratings |

## Metadata coverage

Measured on `movies_metadata.csv`:

| Field | Present |
|---|---|
| `overview` | 44,507 (97.9%) |
| `runtime` | 45,203 (99.4%) |
| `poster_path` | 45,080 (99.2%) |
| `vote_average`, `vote_count` | 45,460 |
| `popularity` | 45,461 |
| `genres` | 45,466 |
| `tagline` | 20,411 (44.9%) |

Overviews average 55 words (median 48); 9,285 are shorter than 25 words. Runtime median is 95 minutes. Releases span 1874–2020, but the snapshot ends in 2017: it contains nothing from 2018 onward.

## Defects

- Three malformed `id` values that are dates: `1997-08-20`, `2012-09-29`, `2014-01-01`.
- 45,436 unique IDs across 45,466 rows; 29 IDs are duplicated.
- 959 rows have an empty overview, 386 have no poster, 263 have no runtime.
- `status` is `Released` for 45,014 rows, `Rumored` for 230, `Post Production` for 98, blank for 81.
- 9 rows are marked adult.
- `genres`, `keywords` and `production_companies` are JSON-like strings that need parsing, not JSON.

## Embeddings

No vectors are included. Generate 384-dimensional MiniLM embeddings locally from `overview`, `tagline`, `keywords` and `genres`, using `@huggingface/transformers` as ARCHITECTURE.md specifies. Stored as `vector(384)`, roughly 70 MB for the full catalog. The model is loaded once and the whole catalog is embedded in one batch pass.

## License and provenance

Kaggle labels the dataset CC0: Public Domain. That label does not hold: the description states the data is an ensemble collected from TMDB and GroupLens, and neither upstream permits relicensing.

- TMDB API terms forbid caching content for longer than six months, collecting datasets for ML training or validation, and commercial use without a written agreement; attribution with the TMDB logo is required.
- GroupLens ratings are licensed for research use and may not be used for commercial or revenue-bearing purposes without permission.

Consequence: treat this as a personal, non-commercial catalog. The app is a local MVP and does not redistribute the data or operate commercially. A public or commercial launch requires TMDB licensing and GroupLens permission, or a different catalog. This risk is recorded here and in ARCHITECTURE.md rather than treated as resolved.

The 26M ratings are not imported into the application database. Guests rate locally in IndexedDB; the ratings file is used only for offline evaluation of ranking against a popularity baseline.

## Cleaning rules for the importer

1. Drop rows whose `id` is not an integer.
2. Collapse duplicate IDs, keeping the row with the highest `vote_count`.
3. Keep only `status = Released`.
4. Drop adult rows.
5. Require a non-empty `overview` or `keywords`; otherwise the row has nothing to embed.
6. Parse `release_date` to a year; leave it null when invalid.
7. Take one director and a bounded list of cast members from `credits.csv`.
8. Store `poster_path` as the TMDB path only, never a full URL.

Expected result: about 45,200 rows.

## Candidates rejected

| Candidate | Reason |
|---|---|
| HF `RobinMillford/movie-embeddings-rag-db` | 7,732 movies, all 2022–2025, 46% TV, no posters |
| HF `NiklasAbraham/MoviePlotEmbeddingsDataset` | 1024-dim bge-m3 (schema and model change), no posters, non-commercial |
| MovieLens latest | No text, no posters, no embeddings; research-only license |
| GitHub `MiKinSwan/tmdb-movies-dataset` | No data committed, no license, leaked API keys |
| HF `Coder-Dragon/wikipedia-movies` | 30,671 rows, ends 2017, 91% fair-use images, no runtime or IDs |
| Kaggle `tmdb/tmdb-movie-metadata` | 4,803 movies, no posters, no ratings, license "Other" |
| Kaggle `imdb-10000-most-voted-feature-films` | No license, no posters or IDs, 26-word descriptions, most-voted only |
| Kaggle `imdb-dataset-of-top-1000` | 1,000 movies, rating floor 7.6, no IDs, Amazon-hotlinked posters, no license |

## Out of scope

- Refreshing the catalog with newer releases. The importer is idempotent so a newer snapshot can be re-imported later.
- Fetching anything from the TMDB API at runtime.
- Downloading or re-hosting poster images.
