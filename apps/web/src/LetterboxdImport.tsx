import { useState, type ChangeEvent } from 'react';
import type { LetterboxdImportResponse, LetterboxdUnmatched } from '@movie-recommender/shared';
import { RecommendationApiError, RecommendationNetworkError, importLetterboxd } from './api';
import { detectLetterboxdFileType } from './letterboxdFileType';
import type { GuestProfile } from './profile/GuestProfile';

interface FileImportResult {
  report: LetterboxdImportResponse;
  ratings: number;
  watchings: number;
  watchlisted: number;
}

type ImportState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; results: FileImportResult[]; failures: string[] };

const READ_ERROR_MESSAGE =
  'Could not read that file. Choose it again or re-export it from Letterboxd.';
const IMPORT_ERROR_MESSAGE = 'Something went wrong while importing. Try again.';
const WRITE_ERROR_MESSAGE = 'Could not save the imported films to your library. Try again.';
const EMPTY_REPORT_MESSAGE = 'No films from that import are in the catalog yet.';

function importErrorMessage(error: unknown): string {
  if (error instanceof RecommendationApiError || error instanceof RecommendationNetworkError) {
    return error.message;
  }

  return IMPORT_ERROR_MESSAGE;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Writes that completed before a save failure remain in the profile, so the
 * failure must say how many films were kept instead of implying none were.
 */
function saveFailureMessage(saved: number): string {
  return `Saved ${saved} ${plural(saved, 'film', 'films')} from this file before the save failed. Try again.`;
}

/**
 * One sentence over every file that imported successfully. Ratings and
 * watches are reported as an import; watchlist films are reported separately
 * because they are not watched and must not read like it. Files that failed
 * are reported by their own message instead of being folded into these counts.
 */
function importSummary(results: readonly FileImportResult[]): string {
  const totals = results.reduce(
    (sum, result) => ({
      ratings: sum.ratings + result.ratings,
      watchings: sum.watchings + result.watchings,
      watchlisted: sum.watchlisted + result.watchlisted,
    }),
    { ratings: 0, watchings: 0, watchlisted: 0 },
  );
  const clauses: string[] = [];

  if (totals.ratings > 0 || totals.watchings > 0) {
    const ratingWord = plural(totals.ratings, 'rating', 'ratings');
    const filmWord = plural(totals.watchings, 'film', 'films');

    if (totals.ratings > 0 && totals.watchings > 0) {
      clauses.push(
        `Imported ${totals.ratings} ${ratingWord} and marked ${totals.watchings} ${filmWord} watched`,
      );
    } else if (totals.ratings > 0) {
      clauses.push(`Imported ${totals.ratings} ${ratingWord}`);
    } else {
      clauses.push(`Marked ${totals.watchings} ${filmWord} watched`);
    }
  }

  if (totals.watchlisted > 0) {
    const filmWord = plural(totals.watchlisted, 'film', 'films');
    const lead = clauses.length === 0 ? 'Added' : 'added';

    clauses.push(`${lead} ${totals.watchlisted} ${filmWord} to your watchlist`);
  }

  return `${clauses.join('; ')}.`;
}

function unmatchedKey(name: string, year: number | null): string {
  return `${name}\u0000${year === null ? '' : String(year)}`;
}

export interface LetterboxdImportProps {
  profile: GuestProfile;
  onRatingImported: (movieId: number, rating: number) => void;
  onWatchedImported: (movieId: number) => void;
  onWatchlistImported: (movieId: number) => void;
}

export function LetterboxdImport({
  profile,
  onRatingImported,
  onWatchedImported,
  onWatchlistImported,
}: LetterboxdImportProps) {
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const pending = state.status === 'pending';
  const unmatched = state.status === 'done' ? unmatchedRows(state.results) : [];

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const files = Array.from(input.files ?? []);

    // Allow re-selecting the same files after a failed or completed import.
    input.value = '';

    if (pending || files.length === 0) {
      return;
    }

    setState({ status: 'pending' });

    const results: FileImportResult[] = [];
    const failures: string[] = [];

    for (const file of files) {
      let csv: string;

      try {
        csv = await file.text();
      } catch {
        failures.push(READ_ERROR_MESSAGE);
        continue;
      }

      // Ratings are identified by the header; a watchlist export shares
      // watches.csv's header, so its original filename is the disambiguator.
      const mode = detectLetterboxdFileType(csv, file.name);
      let report: LetterboxdImportResponse;

      try {
        report = await importLetterboxd(csv);
      } catch (error) {
        failures.push(importErrorMessage(error));
        continue;
      }

      let ratings = 0;
      let watchings = 0;
      let watchlisted = 0;

      try {
        for (const match of report.matched) {
          if (mode === 'watchlist') {
            // A watchlist film is only a wish, never watched or rated.
            await profile.addToWatchlist(match.movieId);
            watchlisted += 1;
            onWatchlistImported(match.movieId);
          } else if (mode === 'ratings' && match.rating !== null) {
            await profile.setRating(match.movieId, match.rating);
            ratings += 1;
            onRatingImported(match.movieId, match.rating);
          } else {
            // Watches exports carry no rating; a ratings export can still
            // contain a rated-null row, which means "seen, not rated".
            await profile.setWatched(match.movieId);
            watchings += 1;
            onWatchedImported(match.movieId);
          }
        }
      } catch {
        // Earlier successful writes stay; only this file is reported failed.
        // Name their number so the message does not imply the whole file was lost.
        const saved = ratings + watchings + watchlisted;

        failures.push(saved === 0 ? WRITE_ERROR_MESSAGE : saveFailureMessage(saved));
        continue;
      }

      results.push({ report, ratings, watchings, watchlisted });
    }

    setState({ status: 'done', results, failures });
  }

  return (
    <div className="import">
      <label className={`import__file${pending ? ' import__file--disabled' : ''}`}>
        {pending ? 'Importing…' : 'Import from Letterboxd'}
        <input
          type="file"
          name="letterboxd-files"
          accept=".csv,text/csv"
          multiple
          disabled={pending}
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
      </label>

      <p className="status import__status">
        Keep the export&apos;s original file names so ratings, watches and watchlist files are
        recognized.
      </p>

      {pending && <p className="status import__status">Matching your films against the catalog…</p>}

      <div className="import__report">
        <div role="status" aria-live="polite" aria-atomic="false">
          {state.status === 'done' && state.results.length > 0 && (
            <p className="status import__status">
              {state.results.every((result) => result.report.matched.length === 0)
                ? EMPTY_REPORT_MESSAGE
                : importSummary(state.results)}
            </p>
          )}

          {state.status === 'done' &&
            state.failures.map((message, index) => (
              <p className="status status--error import__status" key={`${index}:${message}`}>
                {message}
              </p>
            ))}
        </div>

        {state.status === 'done' && unmatched.length > 0 && (
          <details className="import__unmatched">
            <summary>
              Not in the catalog: {unmatched.length === 1 ? '1 film' : `${unmatched.length} films`}
            </summary>
            <ul className="import__list">
              {unmatched.map((row) => (
                <li key={unmatchedKey(row.name, row.year)}>
                  {row.year === null ? row.name : `${row.name} (${row.year})`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

/** Deduplicates unmatched films when several files contain the same miss. */
function unmatchedRows(results: readonly FileImportResult[]): LetterboxdUnmatched[] {
  const rows = new Map<string, LetterboxdUnmatched>();

  for (const result of results) {
    for (const unmatched of result.report.unmatched) {
      rows.set(unmatchedKey(unmatched.name, unmatched.year), unmatched);
    }
  }

  return [...rows.values()];
}
