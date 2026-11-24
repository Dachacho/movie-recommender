# Letterboxd integration: research conclusions (Nov 2026)

Question: can we ingest user data (ratings, watched, watchlist, lists) via the
Letterboxd API or by URL, instead of requiring a manual export?

## Findings

- The Letterboxd API is **request-only and explicitly refuses our project
  category**. From letterboxd.com/api-beta: access is granted selectively, and
  "we are not granting access for data-analysis, visualization or recommendation
  projects, for LLM or GPT-related use, for private or personal projects, or for
  any usage that recreates current or planned features of our paid subscription
  tiers." A personal recommendation app is doubly disqualified.
- Letterboxd's own recommendation for account data is the **export facility**
  (letterboxd.com/user/exportdata): a ZIP of CSVs including ratings.csv,
  watched.csv, watchlist.csv, diary.csv, lists and profile. That matches
  PRODUCT.md's "CSV or pasted list contents" MVP design.
- Every member has a **public RSS feed** (letterboxd.com/USERNAME/rss/) carrying
  only the latest ~50 diary entries (with tmdb:movieId and ratings) — no
  watchlist, no full history. Their API page offers it for syndication, not bulk
  ingestion.
- The Terms of Use (updated Oct 2026) **prohibit scraping** ("you must not
  employ any robot, spider, scraper... to access, acquire, copy or monitor any
  portion of the Service"). List-by-URL would require scraping or the refused
  API, so it stays deferred per PRODUCT.md ("URL only if permitted").

## Consequences for this project

- The export -> import flow is the sanctioned route, not a workaround. One
  export contains everything; the import is idempotent (dedupe on movie id), so
  re-exporting and re-importing after Letterboxd sessions is safe.
- The user's own lists arrive in the export as CSV files; other people's lists
  can be pasted into the pasted-list source.
- The official API remains the thing to re-check at productionization; if
  Letterboxd ever opens access to recommendation apps, user-data ingestion and
  list-by-URL both become possible through it.

## Implementation status (Nov 2026)

- `POST /imports/letterboxd` matches `ratings.csv`, `watches.csv` and
  `watchlist.csv` rows against the catalog by title and year, returns a
  matched/unmatched report, and never invents a film. A rated row implies
  watched.
- Unmatched films stay unmatched: resolving them through the live TMDB API is a
  separate, blocked backlog ticket (API key, catalog-drift and TMDB caching
  terms).
- The profile export writes Letterboxd's ratings column layout
  (`Date,Name,Year,Letterboxd URI,Rating`), but the URI column is intentionally
  empty: the app never stores Letterboxd URIs, and fabricating them is not an
  option.
