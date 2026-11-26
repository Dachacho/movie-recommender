import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LetterboxdImportResponse, MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Library, type LibraryTab } from './Library';
import type { MovieLookup } from './movieLookup';
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

function renderLibrary(
  profile: GuestProfile = createProfile(),
  tab: LibraryTab = 'find',
  lookup?: MovieLookup,
): void {
  render(<Library profile={profile} tab={tab} {...(lookup === undefined ? {} : { lookup })} />);
}

function fakeLookup(movies: readonly MovieCard[]): MovieLookup {
  return {
    resolveMany: async (ids) => {
      const byId = new Map(movies.map((movie) => [movie.id, movie]));

      return new Map(ids.map((movieId) => [movieId, byId.get(movieId) ?? null]));
    },
  };
}

function movieCard(id: number): MovieCard {
  return {
    id,
    title: `Film ${String(id)}`,
    releaseYear: 1990 + (id % 30),
    runtime: 100,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
  };
}

function fileWithText(text: string, name?: string): File {
  return {
    text: async () => text,
    ...(name === undefined ? {} : { name }),
  } as unknown as File;
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
    expect(
      screen.getByText(
        "Keep the export's original file names so ratings, watches and watchlist files are recognized.",
      ),
    ).toBeTruthy();
    selectFile(fileWithText(CSV_TEXT));

    expect(await screen.findByText('Imported 2 ratings and marked 1 film watched.')).toBeTruthy();

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

  it('reports a ratings-only import without a watches clause', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const ratingsCsv =
      'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Arrival,2016,,4.5\n2024-01-02,Heat,1995,,3';

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [
          { movieId: 11, title: 'Arrival', releaseYear: 2016, rating: 4.5 },
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: 3 },
        ],
        unmatched: [],
        stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
      }),
    );

    renderLibrary(profile);
    selectFile(fileWithText(ratingsCsv, 'ratings.csv'));

    expect(await screen.findByText('Imported 2 ratings.')).toBeTruthy();
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('uses a plural film count for a watches-only import', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const watchesCsv =
      'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,\n2024-01-02,Moonlight,2016,';

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: null },
          { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null },
        ],
        unmatched: [],
        stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
      }),
    );

    renderLibrary(profile);
    selectFile(fileWithText(watchesCsv, 'watches.csv'));

    expect(await screen.findByText('Marked 2 films watched.')).toBeTruthy();
    await expect(profile.getWatchedIds()).resolves.toEqual([12, 13]);
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

    expect(await screen.findByText('Imported 1 rating.')).toBeTruthy();
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
      await screen.findByText('Saved 1 film from this file before the save failed. Try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/^Imported /)).toBeNull();
    expect(importInput().disabled).toBe(false);

    expect(attemptedMovieIds).toEqual([11, 12]);
    expect(
      (await profile.getRatings()).map(({ movieId, rating }) => ({ movieId, rating })),
    ).toEqual([{ movieId: 11, rating: 4 }]);
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('announces the import summary in a polite live region', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    fetchMock.mockResolvedValue(jsonResponse(IMPORT_RESPONSE));

    renderLibrary(profile);
    selectFile(fileWithText(CSV_TEXT));

    const summary = await screen.findByText('Imported 2 ratings and marked 1 film watched.');
    const liveRegion = summary.closest('[role="status"]');

    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.textContent).toContain('Imported 2 ratings and marked 1 film watched.');
  });

  it('reports how many watchlist films were saved before a save failure', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const originalAddToWatchlist = profile.addToWatchlist.bind(profile);
    const watchlistCsv =
      'Date,Name,Year,Letterboxd URI\n2024-01-04,Heat,1995,\n2024-01-04,Moonlight,2016,';

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: null },
          { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null },
        ],
        unmatched: [],
        stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
      }),
    );
    vi.spyOn(profile, 'addToWatchlist').mockImplementation(async (movieId) => {
      if (movieId === 13) {
        throw new Error('Quota exceeded');
      }

      return originalAddToWatchlist(movieId);
    });

    renderLibrary(profile);
    selectFile(fileWithText(watchlistCsv, 'watchlist.csv'));

    const failure = await screen.findByText(
      'Saved 1 film from this file before the save failed. Try again.',
    );

    expect(failure.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/^Added /)).toBeNull();
    await expect(profile.getWatchlistIds()).resolves.toEqual([12]);
  });

  it('reports the generic save error when no film was saved', async () => {
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

    const failure = await screen.findByText(
      'Could not save the imported films to your library. Try again.',
    );

    expect(failure.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/^Saved /)).toBeNull();
  });

  it('adds a watchlist export to the guest watchlist instead of marking films watched', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const setWatched = vi.spyOn(profile, 'setWatched');
    const setRating = vi.spyOn(profile, 'setRating');
    const watchlistCsv =
      'Date,Name,Year,Letterboxd URI\n2024-01-04,Heat,1995,\n2024-01-04,Moonlight,2016,';

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: null },
          { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null },
        ],
        unmatched: [],
        stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
      }),
    );

    renderLibrary(profile);
    selectFile(fileWithText(watchlistCsv, 'watchlist.csv'));

    expect(await screen.findByText('Added 2 films to your watchlist.')).toBeTruthy();
    expect(submittedBody(fetchMock)).toEqual({ csv: watchlistCsv });
    await expect(profile.getWatchlistIds()).resolves.toEqual([12, 13]);
    await expect(profile.getWatchedIds()).resolves.toEqual([]);
    await expect(profile.getRatings()).resolves.toEqual([]);
    expect(setWatched).not.toHaveBeenCalled();
    expect(setRating).not.toHaveBeenCalled();
  });

  it('treats a watches export as watched even if a row carries a rating', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const watchesCsv = 'Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,';

    fetchMock.mockResolvedValue(
      jsonResponse({
        matched: [{ movieId: 12, title: 'Heat', releaseYear: 1995, rating: 4 }],
        unmatched: [],
        stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
      }),
    );

    renderLibrary(profile);
    selectFile(fileWithText(watchesCsv, 'watches.csv'));

    expect(await screen.findByText('Marked 1 film watched.')).toBeTruthy();
    await expect(profile.getWatchedIds()).resolves.toEqual([12]);
    await expect(profile.getRatings()).resolves.toEqual([]);
    await expect(profile.getWatchlistIds()).resolves.toEqual([]);
  });

  it('maps ratings, watches and watchlist files selected together separately', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const setWatched = vi.spyOn(profile, 'setWatched');
    const addToWatchlist = vi.spyOn(profile, 'addToWatchlist');
    const ratingsCsv =
      'Date,Name,Year,Letterboxd URI,Rating\n' +
      '2024-01-01,Arrival,2016,,4.5\n' +
      '2024-01-02,Heat,1995,,3';
    const watchesCsv = 'Date,Name,Year,Letterboxd URI\n2024-01-03,Alien,1979,';
    // Real watchlist exports share watches.csv's header and are told apart
    // only by their original filename.
    const watchlistCsv =
      'Date,Name,Year,Letterboxd URI\n2024-01-04,Heat,1995,\n2024-01-04,Moonlight,2016,';

    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { csv: string };

      if (body.csv === ratingsCsv) {
        return jsonResponse({
          matched: [
            { movieId: 11, title: 'Arrival', releaseYear: 2016, rating: 4.5 },
            { movieId: 12, title: 'Heat', releaseYear: 1995, rating: 3 },
          ],
          unmatched: [],
          stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
        });
      }

      if (body.csv === watchesCsv) {
        return jsonResponse({
          matched: [{ movieId: 14, title: 'Alien', releaseYear: 1979, rating: null }],
          unmatched: [],
          stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
        });
      }

      return jsonResponse({
        matched: [
          { movieId: 12, title: 'Heat', releaseYear: 1995, rating: null },
          { movieId: 13, title: 'Moonlight', releaseYear: 2016, rating: null },
        ],
        unmatched: [],
        stats: { rows: 2, matched: 2, unmatched: 0, invalid: 0 },
      });
    });

    renderLibrary(profile);
    fireEvent.change(importInput(), {
      target: {
        files: [
          fileWithText(ratingsCsv, 'ratings.csv'),
          fileWithText(watchesCsv, 'watches.csv'),
          fileWithText(watchlistCsv, 'watchlist.csv'),
        ],
      },
    });

    expect(
      await screen.findByText(
        'Imported 2 ratings and marked 1 film watched; added 2 films to your watchlist.',
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      (await profile.getRatings()).map(({ movieId, rating }) => ({ movieId, rating })),
    ).toEqual([
      { movieId: 11, rating: 4.5 },
      { movieId: 12, rating: 3 },
    ]);
    await expect(profile.getWatchlistIds()).resolves.toEqual([12, 13]);
    await expect(profile.getWatchedIds()).resolves.toEqual([14]);
    expect(setWatched.mock.calls.map(([movieId]) => movieId)).toEqual([14]);
    expect(addToWatchlist.mock.calls.map(([movieId]) => movieId)).toEqual([12, 13]);
    expect(importInput().disabled).toBe(false);
  });

  it('keeps an earlier successful file when a later file fails', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();
    const watchlistCsv = 'Date,Name,Year,Letterboxd URI\n2024-01-04,Heat,1995,';
    const brokenCsv = 'not a letterboxd export';

    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { csv: string };

      if (body.csv === watchlistCsv) {
        return jsonResponse({
          matched: [{ movieId: 12, title: 'Heat', releaseYear: 1995, rating: null }],
          unmatched: [],
          stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
        });
      }

      return jsonResponse(
        { error: { code: 'invalid_csv', message: 'CSV must include a Name column.' } },
        400,
      );
    });

    renderLibrary(profile);
    fireEvent.change(importInput(), {
      target: {
        files: [fileWithText(watchlistCsv, 'watchlist.csv'), fileWithText(brokenCsv, 'broken.csv')],
      },
    });

    expect(await screen.findByText('Added 1 film to your watchlist.')).toBeTruthy();
    expect(await screen.findByText('CSV must include a Name column.')).toBeTruthy();
    await expect(profile.getWatchlistIds()).resolves.toEqual([12]);
    expect(importInput().disabled).toBe(false);
  });

  it('reflects an imported watchlist film in search results', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    fetchMock.mockImplementation(async (input) => {
      if (typeof input === 'string' && input.startsWith('/api/movies/search')) {
        return jsonResponse({ movies: [HEAT] });
      }

      return jsonResponse({
        matched: [{ movieId: 3, title: 'Heat', releaseYear: 1995, rating: null }],
        unmatched: [],
        stats: { rows: 1, matched: 1, unmatched: 0, invalid: 0 },
      });
    });

    renderLibrary(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const watchlistToggle = await screen.findByRole('button', { name: 'Heat: watchlist' });
    expect(watchlistToggle.getAttribute('aria-pressed')).toBe('false');

    selectFile(
      fileWithText('Date,Name,Year,Letterboxd URI\n2024-01-04,Heat,1995,', 'watchlist.csv'),
    );

    expect(await screen.findByText('Added 1 film to your watchlist.')).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Heat: watchlist' }).getAttribute('aria-pressed'),
      ).toBe('true');
    });
    expect(screen.getByRole('button', { name: 'Heat: watched' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('removes a rating from its search row', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(HEAT.id, 4);
    fetchMock.mockResolvedValue(jsonResponse({ movies: [HEAT] }));

    renderLibrary(profile);
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const clearRating = await screen.findByRole('button', { name: 'Remove rating for Heat' });
    fireEvent.click(clearRating);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove rating for Heat' })).toBeNull(),
    );
    await expect(profile.getRatings()).resolves.toEqual([]);
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

describe('Library idle state', () => {
  const IDLE_COPY = 'Search the catalog to rate a film, mark it watched, or save it for later.';

  it('introduces the search under tab counts and keeps the dashboard link', async () => {
    const fetchMock = stubFetch();
    const profile = createProfile();

    await profile.setRating(3, 4.5);
    await profile.setRating(1, 4);
    await profile.setWatched(3);
    await profile.addToWatchlist(3);
    await profile.addToWatchlist(1);
    await profile.addToWatchlist(2);

    renderLibrary(profile);

    expect(screen.getByText(IDLE_COPY)).toBeTruthy();

    const tabs = screen.getByRole('navigation', { name: 'Library sections' });

    await waitFor(() => {
      expect(within(tabs).getByRole('link', { name: 'Rated 2' })).toBeTruthy();
      expect(within(tabs).getByRole('link', { name: 'Watchlist 3' })).toBeTruthy();
    });
    expect(screen.queryByRole('list', { name: 'Library totals' })).toBeNull();

    const link = screen.getByRole('link', { name: 'Open your dashboard' });
    expect(link.getAttribute('href')).toBe('#dashboard');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides the idle guidance as soon as a search starts', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    renderLibrary();
    expect(screen.getByText(IDLE_COPY)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.queryByText(IDLE_COPY)).toBeNull();
    expect(screen.getByText('Searching the catalog…')).toBeTruthy();
  });
});

describe('Library search announcements', () => {
  it('announces a pending search in a single polite status region', () => {
    const fetchMock = stubFetch();
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    renderLibrary();
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const pending = screen.getByText('Searching the catalog…');
    expect(pending.getAttribute('role')).toBe('status');
    expect(
      screen
        .getAllByRole('status')
        .filter((element) => element.textContent?.includes('Searching the catalog…')),
    ).toHaveLength(1);
  });

  it('announces a failed search as an alert', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderLibrary();
    fireEvent.change(screen.getByLabelText('Find a film to rate'), {
      target: { value: 'heat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain('Could not reach the recommendation service.');
    expect(screen.queryByText('Searching the catalog…')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('Library collection tabs', () => {
  it('lists rated films by rating then movieId and removes a rating in place', async () => {
    const profile = createProfile();
    const lookup = fakeLookup([movieCard(1), movieCard(2), movieCard(3)]);

    await profile.setRating(1, 4);
    await profile.setRating(2, 5);
    await profile.setRating(3, 4);

    renderLibrary(profile, 'rated', lookup);

    const list = await screen.findByRole('list', { name: 'Rated films' });

    await screen.findByText('Film 2');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.library__title')?.textContent),
    ).toEqual(['Film 2', 'Film 1', 'Film 3']);
    expect(within(list).getByText('5 / 5')).toBeTruthy();
    expect(within(list).getAllByText('4 / 5')).toHaveLength(2);
    expect(within(list).getByText('1991')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Remove rating for Film 1' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove rating for Film 1' })).toBeNull(),
    );

    const tabs = screen.getByRole('navigation', { name: 'Library sections' });

    await waitFor(() => expect(within(tabs).getByRole('link', { name: 'Rated 2' })).toBeTruthy());
    expect(
      (await profile.getRatings()).map(({ movieId, rating }) => ({ movieId, rating })),
    ).toEqual([
      { movieId: 2, rating: 5 },
      { movieId: 3, rating: 4 },
    ]);
  });

  it('shows the write error and keeps the rated row when removal fails', async () => {
    const profile = createProfile();

    await profile.setRating(1, 4);
    vi.spyOn(profile, 'removeRating').mockRejectedValue(new Error('Quota exceeded'));

    renderLibrary(profile, 'rated', fakeLookup([movieCard(1)]));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove rating for Film 1' }));

    expect(await screen.findByText('Could not save your library change. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove rating for Film 1' })).toBeTruthy();
  });

  it('lists watchlist films by id and removes one in place', async () => {
    const profile = createProfile();
    const lookup = fakeLookup([movieCard(1), movieCard(3)]);

    await profile.addToWatchlist(3);
    await profile.addToWatchlist(1);

    renderLibrary(profile, 'watchlist', lookup);

    const list = await screen.findByRole('list', { name: 'Watchlist films' });

    await screen.findByText('Film 1');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.library__title')?.textContent),
    ).toEqual(['Film 1', 'Film 3']);
    expect(within(list).getByText('1991')).toBeTruthy();
    expect(within(list).getByText('1993')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Remove Film 1 from watchlist' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Film 1 from watchlist' })).toBeNull(),
    );
    await expect(profile.getWatchlistIds()).resolves.toEqual([3]);

    const tabs = screen.getByRole('navigation', { name: 'Library sections' });

    await waitFor(() =>
      expect(within(tabs).getByRole('link', { name: 'Watchlist 1' })).toBeTruthy(),
    );
  });

  it('shows the write error and keeps the watchlist row when removal fails', async () => {
    const profile = createProfile();

    await profile.addToWatchlist(1);
    vi.spyOn(profile, 'removeFromWatchlist').mockRejectedValue(new Error('Quota exceeded'));

    renderLibrary(profile, 'watchlist', fakeLookup([movieCard(1)]));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Film 1 from watchlist' }));

    expect(await screen.findByText('Could not save your library change. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Film 1 from watchlist' })).toBeTruthy();
  });

  it('moves focus to the next row after removing a rating', async () => {
    const profile = createProfile();

    await profile.setRating(1, 4);
    await profile.setRating(2, 4);
    await profile.setRating(3, 4);

    renderLibrary(profile, 'rated', fakeLookup([movieCard(1), movieCard(2), movieCard(3)]));

    await screen.findByText('Film 1');

    const clearFirst = screen.getByRole('button', { name: 'Remove rating for Film 1' });
    clearFirst.focus();
    fireEvent.click(clearFirst);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove rating for Film 2' }),
      ),
    );
  });

  it('moves focus to the previous row after removing the last rating', async () => {
    const profile = createProfile();

    await profile.setRating(1, 4);
    await profile.setRating(2, 4);

    renderLibrary(profile, 'rated', fakeLookup([movieCard(1), movieCard(2)]));

    await screen.findByText('Film 2');

    const clearLast = screen.getByRole('button', { name: 'Remove rating for Film 2' });
    clearLast.focus();
    fireEvent.click(clearLast);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove rating for Film 1' }),
      ),
    );
  });

  it('returns focus to the previous row when the last row of a later page disappears', async () => {
    const profile = createProfile();
    const cards = Array.from({ length: 13 }, (_value, index) => movieCard(index + 1));

    for (const card of cards) {
      await profile.setRating(card.id, 4);
    }

    renderLibrary(profile, 'rated', fakeLookup(cards));

    const list = await screen.findByRole('list', { name: 'Rated films' });

    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();
    await within(list).findByText('Film 13');

    const clearLast = within(list).getByRole('button', { name: 'Remove rating for Film 13' });
    clearLast.focus();
    fireEvent.click(clearLast);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove rating for Film 12' }),
      ),
    );
  });

  it('moves focus to the empty-state action after removing the only rating', async () => {
    const profile = createProfile();

    await profile.setRating(1, 4);

    renderLibrary(profile, 'rated', fakeLookup([movieCard(1)]));

    const clearOnly = await screen.findByRole('button', { name: 'Remove rating for Film 1' });
    clearOnly.focus();
    fireEvent.click(clearOnly);

    const emptyAction = await screen.findByRole('link', { name: 'Find films to rate' });
    await waitFor(() => expect(document.activeElement).toBe(emptyAction));
  });

  it('moves focus to the next row after removing a watchlist film', async () => {
    const profile = createProfile();

    await profile.addToWatchlist(1);
    await profile.addToWatchlist(3);

    renderLibrary(profile, 'watchlist', fakeLookup([movieCard(1), movieCard(3)]));

    await screen.findByText('Film 1');

    const removeFirst = screen.getByRole('button', { name: 'Remove Film 1 from watchlist' });
    removeFirst.focus();
    fireEvent.click(removeFirst);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Film 3 from watchlist' }),
      ),
    );
  });

  it('drops a removal focus request when the removal finishes after a tab change', async () => {
    const profile = createProfile();
    const lookup = fakeLookup([movieCard(1), movieCard(2)]);

    await profile.setRating(1, 4);
    await profile.setRating(2, 4);
    await profile.addToWatchlist(2);

    let finishRemoval: (() => void) | undefined;

    vi.spyOn(profile, 'removeRating').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        }),
    );

    const view = render(<Library profile={profile} tab="rated" lookup={lookup} />);

    await screen.findByText('Film 1');

    const clearFirst = screen.getByRole('button', { name: 'Remove rating for Film 1' });
    clearFirst.focus();
    fireEvent.click(clearFirst);

    // The new tab contains the neighbour's movie id, which the old hand-off
    // would have matched if the request were applied across tabs.
    view.rerender(<Library profile={profile} tab="watchlist" lookup={lookup} />);

    const newTabControl = await screen.findByRole('button', {
      name: 'Remove Film 2 from watchlist',
    });

    await act(async () => {
      finishRemoval?.();
    });

    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(newTabControl);

    // The request was cleared, not merely deferred: returning to the rated
    // tab must not focus the surviving row either.
    view.rerender(<Library profile={profile} tab="rated" lookup={lookup} />);

    const clearSecond = await screen.findByRole('button', { name: 'Remove rating for Film 2' });

    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(clearSecond);
  });

  it('paginates twelve films per page and advances with Next', async () => {
    const profile = createProfile();
    const cards = Array.from({ length: 13 }, (_value, index) => movieCard(index + 1));

    for (const card of cards) {
      await profile.setRating(card.id, 4);
    }

    renderLibrary(profile, 'rated', fakeLookup(cards));

    const list = await screen.findByRole('list', { name: 'Rated films' });

    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    expect(within(list).queryByText('Film 13')).toBeNull();
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Film 13')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('resolves at most twelve titles for the visible page of a thousand-film library', async () => {
    const storage = new MemoryGuestProfileStorage();
    const profile = new GuestProfile(storage);
    const resolvedIds: number[][] = [];
    const lookup: MovieLookup = {
      resolveMany: async (ids) => {
        resolvedIds.push([...ids]);

        return new Map(ids.map((movieId) => [movieId, null]));
      },
    };

    storage.seedRatings(
      Array.from({ length: 1000 }, (_value, index) => ({
        movieId: index + 1,
        rating: 4,
        updatedAt: index,
      })),
    );

    renderLibrary(profile, 'rated', lookup);

    expect(await screen.findByText('Page 1 of 84')).toBeTruthy();
    await waitFor(() => expect(resolvedIds).toHaveLength(1));
    expect(resolvedIds[0]).toEqual(Array.from({ length: 12 }, (_value, index) => index + 1));
    expect(await screen.findByText('Movie #1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Page 2 of 84')).toBeTruthy();
    await waitFor(() => expect(resolvedIds).toHaveLength(2));
    expect(resolvedIds[1]).toEqual(Array.from({ length: 12 }, (_value, index) => index + 13));
    expect(resolvedIds.every((ids) => ids.length <= 12)).toBe(true);
  });
});
