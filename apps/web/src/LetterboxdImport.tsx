import { useState, type ChangeEvent } from 'react';
import type { LetterboxdImportResponse } from '@movie-recommender/shared';
import { RecommendationApiError, RecommendationNetworkError, importLetterboxd } from './api';
import type { GuestProfile } from './profile/GuestProfile';

type ImportState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; report: LetterboxdImportResponse; ratings: number; watchings: number }
  | { status: 'error'; message: string };

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

function importSummary(ratings: number, watchings: number, rows: number): string {
  const ratingWord = ratings === 1 ? 'rating' : 'ratings';
  const watchingWord = watchings === 1 ? 'watching' : 'watchings';
  const rowWord = rows === 1 ? 'row' : 'rows';

  return `Imported ${ratings} ${ratingWord} and ${watchings} ${watchingWord} from ${rows} ${rowWord}.`;
}

function unmatchedKey(name: string, year: number | null): string {
  return `${name}\u0000${year === null ? '' : String(year)}`;
}

export interface LetterboxdImportProps {
  profile: GuestProfile;
  onRatingImported: (movieId: number, rating: number) => void;
  onWatchedImported: (movieId: number) => void;
}

export function LetterboxdImport({
  profile,
  onRatingImported,
  onWatchedImported,
}: LetterboxdImportProps) {
  const [state, setState] = useState<ImportState>({ status: 'idle' });
  const pending = state.status === 'pending';

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0] ?? null;

    // Allow re-selecting the same file after a failed or completed import.
    input.value = '';

    if (pending || file === null) {
      return;
    }

    setState({ status: 'pending' });

    let csv: string;

    try {
      csv = await file.text();
    } catch {
      setState({ status: 'error', message: READ_ERROR_MESSAGE });
      return;
    }

    let report: LetterboxdImportResponse;

    try {
      report = await importLetterboxd(csv);
    } catch (error) {
      setState({ status: 'error', message: importErrorMessage(error) });
      return;
    }

    let ratings = 0;
    let watchings = 0;

    try {
      for (const match of report.matched) {
        if (match.rating === null) {
          await profile.setWatched(match.movieId);
          watchings += 1;
          onWatchedImported(match.movieId);
        } else {
          await profile.setRating(match.movieId, match.rating);
          ratings += 1;
          onRatingImported(match.movieId, match.rating);
        }
      }
    } catch {
      setState({ status: 'error', message: WRITE_ERROR_MESSAGE });
      return;
    }

    setState({ status: 'done', report, ratings, watchings });
  }

  return (
    <div className="import">
      <label className={`import__file${pending ? ' import__file--disabled' : ''}`}>
        {pending ? 'Importing…' : 'Import from Letterboxd'}
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={pending}
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
      </label>

      {pending && <p className="status import__status">Matching your films against the catalog…</p>}

      {state.status === 'error' && (
        <p className="status status--error import__status">{state.message}</p>
      )}

      {state.status === 'done' && (
        <div className="import__report">
          <p className="status import__status">
            {state.report.matched.length === 0
              ? EMPTY_REPORT_MESSAGE
              : importSummary(state.ratings, state.watchings, state.report.stats.rows)}
          </p>
          {state.report.unmatched.length > 0 && (
            <details className="import__unmatched">
              <summary>
                Not in the catalog:{' '}
                {state.report.unmatched.length === 1
                  ? '1 film'
                  : `${state.report.unmatched.length} films`}
              </summary>
              <ul className="import__list">
                {state.report.unmatched.map((unmatched) => (
                  <li key={unmatchedKey(unmatched.name, unmatched.year)}>
                    {unmatched.year === null
                      ? unmatched.name
                      : `${unmatched.name} (${unmatched.year})`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
