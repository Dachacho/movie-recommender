import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LetterboxdImportResponse, MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Library } from './Library';
import { GuestProfile } from './profile/GuestProfile';
import { MemoryGuestProfileStorage } from './profile/memoryStorage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CSV_TEXT = 'Name,Year,Rating\nArrival,2016,4.5\nHeat,1995,3\nMoonlight,2016';

const IMPORT_RESPONSE: LetterboxdImportResponse = {
  matched: [
    { movieId: 11, title: 'Arrival', releaseYear: 2016, rating: 4.5 },
    { movieId: 12, title: 'Heat', releaseYear: 1995, rating: 3 },
    { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null },
  ],
  unmatched: [{ name: 'The Long Goodbye', year: 1973, reason: 'no_match' }],
  stats: { rows: 5, matched: 3, unmatched: 1, invalid: 1 },
};

const HEAT: MovieCard = {
  id: 3,
  title: 'Heat',
  releaseYear: 1995,
  runtime: 170,
  overview: 'A dedicated detective pursues a crew of professional thieves in Los Angeles.',
  genres: ['Crime', 'Drama'],
  director: 'Michael Mann',
  cast: ['Al Pacino', 'Robert De Niro'],
  posterPath: '/heat.jpg',
  voteAverage: 7.8,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function stubFetch(): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function submittedBody(fetchMock: Mock<typeof fetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];

  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('fetch call has no JSON body');
  }

  return JSON.parse(init.body) as Record<string, unknown>;
}

function createProfile(): GuestProfile {
  return new GuestProfile(new MemoryGuestProfileStorage());
}

function renderLibrary(profile: GuestProfile = createProfile()): void {
  render(<Library profile={profile} />);
}

function fileWithText(text: string): File {
  return { text: async () => text } as unknown as File;
}

function importInput(): HTMLInputElement {
  return screen.getByLabelText('Import from Letterboxd') as HTMLInputElement;
}

function selectFile(file: File): void {
  fireEvent.change(importInput(), { target: { files: [file] } });
}

describe('Letterboxd import', () => {
  it('writes rated and watched matches through the profile and reports the result', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    fetchMock.mockResolvedValue(jsonResponse(IMPORT_RESPONSE));

    renderLibrary(profile);
    selectFile(fileWithText(CSV_TEXT));

    expect(await screen.findByText('Imported 2 ratings and 1 watching from 5 rows.')).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/imports/letterboxd');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(submittedBody(fetchMock)).toEqual({ csv: CSV_TEXT });

    expect(
      (await profile.getRatings()).map(({ movieId, rating }) => ({ movieId, rating })),
    ).toEqual([
      { movieId: 11, rating: 4.5 },
      { movieId: 12, rating: 3 },
    ]);
    await expect(profile.getWatchedIds()).resolves.toEqual([13]);

    const unmatchedSummary = screen.getByText('Not in the catalog: 1 film');
    const unmatchedDetails = unmatchedSummary.closest('details');
    expect(unmatchedDetails?.open).toBe(false);
    fireEvent.click(unmatchedSummary);
    expect(unmatchedDetails?.open).toBe(true);
    expect(screen.getByText('The Long Goodbye (1973)')).toBeTruthy();

    expect(importInput().disabled).toBe(false);
  });

  it('reflects an imported rating in search results without a new search', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockImplementation(async (input) => {
      if (typeof input === 'string' && input.startsWith('/api/movies/search')) {
        return jsonResponse({ movies: [HEAT] });
      }

      return jsonResponse({
        matched: [{ movieId: 3, title: 'Heat', releaseYear: 1995, rating: 3.5 }],
        unmatched: [],
        stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
      });
    });

    renderLibrary(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const ratingGroup = await screen.findByRole('radiogroup', { name: 'Rating for Heat' });
    expect(
      (
        within(ratingGroup).getByRole('radio', {
          name: '3.5 stars out of 5',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);

    selectFile(fileWithText(CSV_TEXT));

    expect(await screen.findByText('Imported 1 rating and 0 watchings from 1 row.')).toBeTruthy();
    await waitFor(() => {
      const updatedGroup = screen.getByRole('radiogroup', { name: 'Rating for Heat' });
      const threeAndAHalfStars = within(updatedGroup).getByRole('radio', {
        name: '3.5 stars out of 5',
      });

      expect((threeAndAHalfStars as HTMLInputElement).checked).toBe(true);
    });

    const searchCalls = fetchMock.mock.calls.filter(
      ([input]) => typeof input === 'string' && input.startsWith('/api/movies/search'),
    );
    expect(searchCalls).toHaveLength(1);
  });

  it('shows a plain empty report when no catalog films matched', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [],
        unmatched: [{ name: 'Sátántangó', year: 1994, reason: 'no_match' }],
        stats: { rows: 1, matched: 0, unmatched: 1, invalid: 0 },
      }),
    );

    renderLibrary(profile);
    selectFile(fileWithText('Name,Year,Rating\nSátántangó,1994'));

    expect(
      await screen.findByText('No films from that import are in the catalog yet.'),
    ).toBeTruthy();
    expect(screen.getByText('Sátántangó (1994)')).toBeTruthy();
    expect(document.querySelector('.status--error')).toBeNull();
    await expect(profile.getRatings()).resolves.toEqual([]);
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('shows the API error message and leaves the import usable', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'invalid_csv', message: 'CSV must include a Name column.' } },
        400,
      ),
    );

    renderLibrary();
    selectFile(fileWithText('not a letterboxd export'));

    expect(await screen.findByText('CSV must include a Name column.')).toBeTruthy();
    expect(importInput().disabled).toBe(false);

    selectFile(fileWithText(CSV_TEXT));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('shows a network error message when the import request cannot be made', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderLibrary();
    selectFile(fileWithText(CSV_TEXT));

    expect(
      await screen.findByText(
        'Could not reach the recommendation service. Check your connection and try again.',
      ),
    ).toBeTruthy();
    expect(importInput().disabled).toBe(false);
  });

  it('shows a read error when the selected file cannot be read', async () => {
    const fetchMock = stubFetch();
    const unreadable = {
      text: async () => {
        throw new Error('read failed');
      },
    } as unknown as File;

    renderLibrary();
    selectFile(unreadable);

    expect(
      await screen.findByText(
        'Could not read that file. Choose it again or re-export it from Letterboxd.',
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(importInput().disabled).toBe(false);
  });

  it('shows a save error when a matched film cannot be written to the profile', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [{ movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null }],
        unmatched: [],
        stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
      }),
    );
    vi.spyOn(profile, 'setWatched').mockRejectedValue(new Error('Quota exceeded'));

    renderLibrary(profile);
    selectFile(fileWithText(CSV_TEXT));

    expect(
      await screen.findByText('Could not save the imported films to your library. Try again.'),
    ).toBeTruthy();
    expect(importInput().disabled).toBe(false);
  });

  it('keeps earlier writes when a later film in the batch fails to save', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const originalSetRating = profile.setRating.bind(profile);
    const attemptedMovieIds: number[] = [];

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [
          { movieId: 11, title: 'Arrival', releaseYear: 2016, rating: 4 },
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: 3 },
          { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: 2 },
        ],
        unmatched: [],
        stats: { rows: 3, matched: 3, unmatched: 0, invalid: 0 },
      }),
    );
    vi.spyOn(profile, 'setRating').mockImplementation(async (movieId, rating) => {
      attemptedMovieIds.push(movieId);

      if (movieId === 12) {
        throw new Error('Quota exceeded');
      }

      return originalSetRating(movieId, rating);
    });

    renderLibrary(profile);
    selectFile(fileWithText(CSV_TEXT));

    expect(
      await screen.findByText('Could not save the imported films to your library. Try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/^Imported /)).toBeNull();
    expect(importInput().disabled).toBe(false);

    expect(attemptedMovieIds).toEqual([11, 12]);
    expect(
      (await profile.getRatings()).map(({ movieId, rating }) => ({ movieId, rating })),
    ).toEqual([{ movieId: 11, rating: 4 }]);
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('does not start a second import while one is pending', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    renderLibrary();
    const input = importInput();

    fireEvent.change(input, { target: { files: [fileWithText('first')] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(input.disabled).toBe(true);
    expect(screen.getByText('Importing…')).toBeTruthy();

    fireEvent.change(input, { target: { files: [fileWithText('second')] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
