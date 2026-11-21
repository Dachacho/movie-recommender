# Catalog snapshot 2026-11-21

Provenance, curation and verification for the catalog re-import that replaced the 2017
`rounakbanik/the-movies-dataset` seed.

## Source

- Kaggle dataset: alanvourch, "TMDB daily updates" (`/datasets/alanvourch/tmdb-daily-updates`).
- File: `TMDB_all_movies.csv`, 809,453,205 bytes, snapshot dated 2026-11-21.
- 1,277,405 data rows and 30 columns, RFC-style quoted CSV (quotes escaped by doubling).
  The importer's streaming reader and Python's `csv` module agree on the record count and
  on every row having 30 fields; the earlier 1,277,424 estimate was off by 19.
- 0 duplicate TMDB ids and 19 rows whose `id` is malformed (for example a date).
- Field formats verified on the file: `genres` and `cast` are comma-separated names,
  `keywords` is pipe-separated, `director` is a single free-text field, `runtime` is a
  float string (`"73.0"`), `release_date` is `YYYY-MM-DD` (empty or partial allowed) and
  `poster_path` is a TMDB path such as `/ojDg0PGvs6R9xYFodRct2kdI6wC.jpg` or empty.

The download is not committed to the repository. Imports read it from `SNAPSHOT_CSV`
(or `--csv <path>`).

## Quality counts

Measured on the snapshot before the import:

| Step | Rows |
|---|---|
| Data rows | 1,277,405 |
| `status = Released` | 1,253,489 |
| + non-empty overview | 1,062,081 |
| + parseable runtime > 0 | 945,902 |
| …with a poster path | 762,875 |

The importer measured these counts directly with a streaming scan, and Python's `csv`
module reproduces them. They sit 266 and 163 rows below the earlier estimates for the
overview and runtime steps, so the earlier figures are superseded.

25 of 25 sampled poster paths resolved live on `image.tmdb.org` (the 2017 dataset
resolved 2 of 30). About 348k rows are post-2020 releases.

Of the 945,902 rows meeting the three conditions, 6 have an empty title and none lacks a
finite `popularity`, leaving 945,896 qualified rows to rank.

## Curation rule

1. Keep rows whose `id` is a positive 32-bit integer, whose `status` is `Released`, that
   have a non-empty `overview` and a parseable `runtime` of at least one whole minute
   (rounded; a runtime that rounds to zero is rejected), and whose `popularity` parses as
   a finite number.
2. Take the top 40,000 rows by `popularity` descending, tie-broken by `id` ascending.
   Selection keeps a bounded heap, so the full catalog is never held in memory.
3. First occurrence wins when an id repeats. This snapshot has none.
4. Bound the stored text: title 512, overview 4000, tagline 500 and director 300
   characters; list entries 200 characters; genres 20, keywords 50 and cast 8 entries.
   Empty optional fields become null, and `poster_path` is kept only when it is a
   relative path.
5. `release_year` comes from the first four digits of `release_date`, null when absent or
   outside 1870–2100.

Popularity is a curation-at-import signal only. It is never an eligibility gate or a
ranking input at recommendation time, per ARCHITECTURE.md. Importing the full ~1.3M-row
catalog remains deferred to productionization.

## Embeddings

Every row is embedded with the pinned pipeline already used by the importer:
`Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9`,
int8 (`q8`), mean pooling and normalization, 384 dimensions. The version string stored in
`embedding_version` is
`all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9/q8/mean/normalized/1`.
Text is title, overview, tagline, genres and keywords, as before.

## License and provenance stance

Kaggle labels the alanvourch export Apache-2.0, but that label is Kaggle's, not TMDB's.
The contents are TMDB metadata, and TMDB's terms still apply: no caching beyond six
months, no dataset collection for ML training or validation, and no commercial use
without a written agreement. As with the previous seed, treat this as a personal,
non-commercial, local MVP catalog; a public or commercial launch requires TMDB licensing
or a different catalog. The dataset is not redistributed by this repository.

## Import and verification

Run from the repository root, with the database up and `DATABASE_URL` set:

```sh
SNAPSHOT_CSV=/path/to/TMDB_all_movies.csv npm run catalog:import-snapshot
```

The importer streams and curates the snapshot, truncates `movies`, embeds and inserts in
batches, then verifies that the table has 40,000 rows, 40,000 unique ids, no missing
embeddings, 384 dimensions everywhere, the current `embedding_version` on every row and
no non-finite values. The catalog size is fixed at 40,000 (`SNAPSHOT_LIMIT`): `--limit` is
rejected, and a run whose qualified pool selects fewer than 40,000 rows fails before
touching the database. `--csv` and `--batch-size` remain available for the path and
embedding batch size. Re-running truncates and re-inserts the same selection, so it is
idempotent.

## Import run

Run on 2026-11-21 against the local PostgreSQL 17 + pgvector database:

| Phase | Result |
|---|---|
| Snapshot size | 809,453,205 bytes |
| Rows scanned | 1,277,405 |
| Rejected as invalid | 331,509 |
| Duplicate ids | 0 |
| Qualified | 945,896 |
| Selected by popularity | 40,000 |
| Parse and curation | 23s |
| Embedding and insert (batch 128) | 1,392s |
| Verification | 40,000 rows, 40,000 unique ids, 0 missing embeddings, 0 non-384-d vectors, 0 rows without the current version, 0 non-finite values |

The resulting catalog has 14,354 films released in 2018 or later (8,846 from 2023 or later),
a year range of 1889–2027, 37,777 poster paths and 17,368 taglines.

Spot check: Oppenheimer (id 872585, 2023) is present with runtime 181, director
Christopher Nolan, popularity 36.8989, a poster path, genres `Drama, History, War` and a
384-d embedding carrying the current version.

Poster sample: 10 random imported poster paths were requested with `HEAD` from
`https://image.tmdb.org/t/p/w500<path>`; all 10 returned `200 image/jpeg`.

Idempotency: a second full run produced the same table — 40,000 rows and identical
checksums of the ordered ids (`8457d5975059380cd4594818c33ecac6`) and titles
(`7843021e5b6bb207b3cd5f9a6e2f3a7a`). Its embedding phase took 1,575s; only elapsed time
changed. A later re-run after the runtime and fixed-size fixes took 1,407s and produced
the same checksums.

