import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import { downloadTextFile } from './download';
import type { MovieLookup } from './movieLookup';
import { GuestProfile } from './profile/GuestProfile';
import { MemoryGuestProfileStorage } from './profile/memoryStorage';
import type { HistoryEntry } from './profile/schema';
import { isoDate, parseProfileBackup } from './profileExport';

vi.mock('./download', () => ({
  downloadTextFile: vi.fn(),
}));

const download = vi.mocked(downloadTextFile);

const NOW = new Date(2026, 10, 24, 15, 4).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

const ARRIVAL: MovieCard = {
  id: 1,
  title: 'Arrival',
  releaseYear: 2016,
  runtime: 116,
  overview: 'A linguist is recruited to communicate with alien lifeforms.',
  genres: ['Science Fiction', 'Drama'],
  director: 'Denis Villeneuve',
  cast: ['Amy Adams'],
  posterPath: '/arrival.jpg',
  voteAverage: 7.6,
};

const MOONLIGHT: MovieCard = {
  id: 2,
  title: 'Moonlight',
  releaseYear: 2016,
  runtime: 111,
  overview: 'A young man grapples with his identity while growing up in Miami.',
  genres: ['Drama'],
  director: 'Barry Jenkins',
  cast: ['Trevante Rhodes'],
  posterPath: '/moonlight.jpg',
  voteAverage: 7.4,
};

const HEAT: MovieCard = {
  id: 3,
  title: 'Heat',
  releaseYear: 1995,
  runtime: 170,
  overview: 'A detective pursues a crew of professional thieves in Los Angeles.',
  genres: ['Crime', 'Drama'],
  director: 'Michael Mann',
  cast: ['Al Pacino'],
  posterPath: '/heat.jpg',
  voteAverage: 7.8,
};

const PADDINGTON_2: MovieCard = {
  id: 4,
  title: 'Paddington 2',
  releaseYear: 2017,
  runtime: 103,
  overview: 'Paddington looks for the perfect gift for his aunt.',
  genres: ['Family', 'Comedy'],
  director: 'Paul King',
  cast: ['Ben Whishaw'],
  posterPath: null,
  voteAverage: 7.6,
};

const THE_LIGHTHOUSE: MovieCard = {
  id: 7,
  title: 'The Lighthouse',
  releaseYear: 2019,
  runtime: 109,
  overview: 'Two lighthouse keepers try to maintain their sanity.',
  genres: ['Drama', 'Horror'],
  director: 'Robert Eggers',
  cast: ['Robert Pattinson'],
  posterPath: '/lighthouse.jpg',
  voteAverage: 7.2,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createProfile(): { profile: GuestProfile; storage: MemoryGuestProfileStorage } {
  const storage = new MemoryGuestProfileStorage();

  return { profile: new GuestProfile(storage, { now: () => NOW }), storage };
}

function fakeLookup(movies: readonly MovieCard[]): MovieLookup {
  return {
    resolveMany: async (ids) => {
      const byId = new Map(movies.map((movie) => [movie.id, movie]));

      return new Map(ids.map((movieId) => [movieId, byId.get(movieId) ?? null]));
    },
  };
}

function snapshot(movie: MovieCard): HistoryEntry['movies'][number] {
  return {
    id: movie.id,
    title: movie.title,
    releaseYear: movie.releaseYear,
    posterPath: movie.posterPath,
  };
}

function renderDashboard(profile: GuestProfile, lookup: MovieLookup): ReturnType<typeof render> {
  return render(<Dashboard profile={profile} lookup={lookup} now={() => NOW} />);
}

describe('Dashboard', () => {
  it('shows distinct counts, the mean rating and the activity window', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 4, updatedAt: NOW - 3000 },
      { movieId: 1, rating: 4.5, updatedAt: NOW - 1000 },
      { movieId: 2, rating: 3.5, updatedAt: NOW - 2000 },
      { movieId: 3, rating: 4, updatedAt: NOW - 2500 },
    ]);
    storage.seedWatched([
      { movieId: 1, watchedAt: NOW },
      { movieId: 2, watchedAt: NOW },
    ]);
    storage.seedWatchlist([
      { movieId: 3, addedAt: NOW },
      { movieId: 4, addedAt: NOW },
    ]);
    storage.seedCooldowns([
      { movieId: 5, expiresAt: NOW + 1000 },
      { movieId: 6, expiresAt: NOW },
    ]);
    storage.seedHistory([
      {
        id: 2,
        createdAt: NOW - 1000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: 1,
        movies: [snapshot(HEAT)],
      },
      {
        id: 1,
        createdAt: NOW - 2000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL)],
      },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2]));

    const summary = await screen.findByText(/in the last 7 days/);
    expect(summary.textContent).toBe(
      'Mean rating 4.0, 2 rounds and 1 replacement in the last 7 days',
    );
    expect(within(summary).getByText('4.0').classList.contains('dashboard__mean')).toBe(true);

    const counts = Array.from(document.querySelectorAll('.dashboard__count')).map(
      (item) => item.textContent,
    );
    expect(counts).toEqual(['3 rated', '2 watched', '2 watchlisted', '1 cooling down']);
  });

  it('uses singular activity copy for a single round', async () => {
    const { profile, storage } = createProfile();

    storage.seedHistory([
      {
        id: 1,
        createdAt: NOW - DAY_MS,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL)],
      },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const summary = await screen.findByText(/in the last 7 days/);
    expect(summary.textContent).toBe(
      'No ratings yet, 1 round and 0 replacements in the last 7 days',
    );
  });

  it('uses plural activity copy and excludes rounds older than seven days', async () => {
    const { profile, storage } = createProfile();
    const olderThanWindow = NOW - 8 * DAY_MS;

    storage.seedHistory([
      {
        id: 4,
        createdAt: NOW - 1000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: 1,
        movies: [snapshot(HEAT)],
      },
      {
        id: 3,
        createdAt: NOW - 2000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: 1,
        movies: [snapshot(HEAT)],
      },
      {
        id: 2,
        createdAt: NOW - 3000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL)],
      },
      {
        id: 1,
        createdAt: olderThanWindow,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(MOONLIGHT)],
      },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT]));

    const summary = await screen.findByText(/in the last 7 days/);
    expect(summary.textContent).toBe(
      'No ratings yet, 3 rounds and 2 replacements in the last 7 days',
    );
  });

  it('counts every retained round but lists only the newest ten', async () => {
    const { profile, storage } = createProfile();

    storage.seedHistory(
      Array.from({ length: 12 }, (_value, index) => {
        const id = index + 1;

        return {
          id,
          createdAt: NOW - (12 - id) * 1000,
          kind: 'round',
          source: 'catalog',
          prompt: '',
          replacedMovieId: null,
          movies: [
            { id: 1000 + id, title: `Film ${String(id)}`, releaseYear: 2000, posterPath: null },
          ],
        };
      }),
    );

    renderDashboard(profile, fakeLookup([]));

    const summary = await screen.findByText(/in the last 7 days/);
    expect(summary.textContent).toBe(
      'No ratings yet, 12 rounds and 0 replacements in the last 7 days',
    );

    const recent = screen.getByRole('region', { name: 'Recent picks' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(10);
    expect(within(recent).getByText('Film 12')).toBeTruthy();
    expect(within(recent).getByText('Film 3')).toBeTruthy();
    expect(within(recent).queryByText('Film 2')).toBeNull();
    expect(within(recent).queryByText('Film 1')).toBeNull();
  });

  it('renders all ten histogram buckets with proportional bars and real labels', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 5, updatedAt: NOW - 3000 },
      { movieId: 2, rating: 5, updatedAt: NOW - 2000 },
      { movieId: 3, rating: 4.5, updatedAt: NOW - 1000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT]));

    const spread = await screen.findByRole('region', { name: 'Rating spread' });
    const rows = within(spread).getAllByRole('listitem');

    expect(rows).toHaveLength(10);

    const labels = ['0.5 stars:', '1 star:', '1.5 stars:', '2 stars:', '2.5 stars:'];
    const upperLabels = ['3 stars:', '3.5 stars:', '4 stars:', '4.5 stars:', '5 stars:'];

    for (const label of [...labels, ...upperLabels]) {
      expect(within(spread).getByText(label)).toBeTruthy();
    }

    const fiveStars = within(spread).getByText('5 stars:').closest('li');
    expect(fiveStars?.textContent).toContain('2 rated films');
    expect(fiveStars?.querySelector<HTMLElement>('.dashboard__histogram-bar')?.style.width).toBe(
      '100%',
    );

    const fourAndAHalf = within(spread).getByText('4.5 stars:').closest('li');
    expect(fourAndAHalf?.textContent).toContain('1 rated film');

    const halfStar = within(spread).getByText('0.5 stars:').closest('li');
    expect(halfStar?.textContent).toContain('0 rated films');
    expect(halfStar?.querySelector<HTMLElement>('.dashboard__histogram-bar')?.style.width).toBe(
      '0%',
    );
    expect(
      halfStar
        ?.querySelector<HTMLElement>('.dashboard__histogram-track')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('resolves rated and watchlist titles from the lookup, newest rating first', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 4, updatedAt: NOW - 2000 },
      { movieId: 7, rating: 4.5, updatedAt: NOW - 1000 },
    ]);
    storage.seedWatchlist([{ movieId: 3, addedAt: NOW }]);

    renderDashboard(profile, fakeLookup([ARRIVAL, HEAT, THE_LIGHTHOUSE]));

    const rated = await screen.findByRole('region', { name: 'Rated films' });
    const rows = within(rated).getAllByRole('listitem');

    expect(rows.map((row) => row.querySelector('.dashboard__row-title')?.textContent)).toEqual([
      'The Lighthouse',
      'Arrival',
    ]);

    expect(within(rated).getByText('4½ / 5')).toBeTruthy();
    expect(within(rated).getByText('4 / 5')).toBeTruthy();
    expect(within(rated).getByText('2019')).toBeTruthy();
    expect(
      within(rated).getByRole('button', { name: 'Remove rating for The Lighthouse' }),
    ).toBeTruthy();

    const watchlist = screen.getByRole('region', { name: 'Watchlist' });
    expect(within(watchlist).getByText('Heat')).toBeTruthy();
    expect(within(watchlist).getByText('1995')).toBeTruthy();
    expect(
      within(watchlist).getByRole('button', { name: 'Remove Heat from watchlist' }),
    ).toBeTruthy();
  });

  it('previews five rows per panel and resolves only the visible ids', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings(
      Array.from({ length: 7 }, (_value, index) => ({
        movieId: index + 1,
        rating: 4,
        updatedAt: NOW - index * 1000,
      })),
    );
    storage.seedWatchlist(
      Array.from({ length: 6 }, (_value, index) => ({
        movieId: 101 + index,
        addedAt: NOW - index * 1000,
      })),
    );

    const baseLookup = fakeLookup([ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2, THE_LIGHTHOUSE]);
    const resolvedIds: number[][] = [];
    const lookup: MovieLookup = {
      resolveMany: async (ids) => {
        resolvedIds.push([...ids]);

        return baseLookup.resolveMany(ids);
      },
    };

    renderDashboard(profile, lookup);

    const rated = await screen.findByRole('region', { name: 'Rated films' });
    const watchlist = screen.getByRole('region', { name: 'Watchlist' });

    expect(within(rated).getAllByRole('listitem')).toHaveLength(5);
    expect(within(watchlist).getAllByRole('listitem')).toHaveLength(5);
    expect(within(rated).getByText(/Showing 5 of 7\./)).toBeTruthy();
    expect(within(watchlist).getByText(/Showing 5 of 6\./)).toBeTruthy();
    expect(
      within(rated).getByRole('link', { name: 'View all rated films.' }).getAttribute('href'),
    ).toBe('#library');
    expect(
      within(watchlist)
        .getByRole('link', { name: 'View all watchlist films.' })
        .getAttribute('href'),
    ).toBe('#library/watchlist');

    await waitFor(() => expect(resolvedIds).toHaveLength(1));
    expect(resolvedIds[0]).toEqual([1, 2, 3, 4, 5, 101, 102, 103, 104, 105]);
    expect(resolvedIds[0]).not.toContain(6);
    expect(resolvedIds[0]).not.toContain(7);
    expect(resolvedIds[0]).not.toContain(106);
  });

  it('keeps the fallback title when the lookup resolves nothing', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 7, rating: 4.5, updatedAt: NOW }]);
    storage.seedWatchlist([{ movieId: 3, addedAt: NOW }]);

    renderDashboard(profile, {
      resolveMany: async (ids) => new Map(ids.map((movieId) => [movieId, null])),
    });

    expect(await screen.findByText('Movie #7')).toBeTruthy();
    expect(screen.getByText('Movie #3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove rating for Movie #7' })).toBeTruthy();
  });

  it('keeps the fallback title when the lookup rejects', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 7, rating: 4.5, updatedAt: NOW }]);

    renderDashboard(profile, {
      resolveMany: () => Promise.reject(new Error('lookup unavailable')),
    });

    expect(await screen.findByText('Movie #7')).toBeTruthy();
  });

  it('drops titles resolved by an earlier load when a reload lookup rejects', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 4.5, updatedAt: NOW - 1000 },
      { movieId: 2, rating: 4, updatedAt: NOW - 2000 },
    ]);

    let calls = 0;
    const lookup: MovieLookup = {
      resolveMany: async (ids) => {
        calls += 1;

        if (calls > 1) {
          throw new Error('lookup unavailable');
        }

        const byId = new Map<number, MovieCard | null>([
          [ARRIVAL.id, ARRIVAL],
          [MOONLIGHT.id, MOONLIGHT],
        ]);

        return new Map(ids.map((movieId) => [movieId, byId.get(movieId) ?? null]));
      },
    };

    renderDashboard(profile, lookup);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove rating for Moonlight' }));

    await waitFor(() => expect(calls).toBe(2));

    expect(await screen.findByRole('button', { name: 'Remove rating for Movie #1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove rating for Movie #2' })).toBeNull();
    expect(screen.queryByText('Arrival')).toBeNull();
  });

  it('removes a rating through the profile and reloads the list', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 4.5, updatedAt: NOW },
      { movieId: 2, rating: 3, updatedAt: NOW - 1 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT]));

    const removeRating = vi.spyOn(profile, 'removeRating');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove rating for Arrival' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove rating for Arrival' })).toBeNull(),
    );
    expect(removeRating).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: 'Remove rating for Moonlight' })).toBeTruthy();
    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 2, rating: 3, updatedAt: NOW - 1 },
    ]);
  });

  it('removes a watchlist film through the profile and reloads the list', async () => {
    const { profile, storage } = createProfile();

    storage.seedWatchlist([
      { movieId: 3, addedAt: NOW },
      { movieId: 4, addedAt: NOW },
    ]);

    renderDashboard(profile, fakeLookup([HEAT, PADDINGTON_2]));

    const removeFromWatchlist = vi.spyOn(profile, 'removeFromWatchlist');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Heat from watchlist' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Heat from watchlist' })).toBeNull(),
    );
    expect(removeFromWatchlist).toHaveBeenCalledWith(3);
    expect(screen.getByText('Paddington 2')).toBeTruthy();
    await expect(profile.getWatchlistIds()).resolves.toEqual([4]);
  });

  it('shows the rating removal error and keeps the rating row', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);
    vi.spyOn(profile, 'removeRating').mockRejectedValue(new Error('Quota exceeded'));

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove rating for Arrival' }));

    expect(await screen.findByText('Could not remove that rating. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove rating for Arrival' })).toBeTruthy();
    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 1, rating: 4.5, updatedAt: NOW },
    ]);
  });

  it('shows the watchlist removal error and keeps the row', async () => {
    const { profile, storage } = createProfile();

    storage.seedWatchlist([{ movieId: 3, addedAt: NOW }]);
    vi.spyOn(profile, 'removeFromWatchlist').mockRejectedValue(new Error('Quota exceeded'));

    renderDashboard(profile, fakeLookup([HEAT]));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Heat from watchlist' }));

    expect(await screen.findByText('Could not change your watchlist. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Heat from watchlist' })).toBeTruthy();
    await expect(profile.getWatchlistIds()).resolves.toEqual([3]);
  });

  it('moves focus to the next rating after removing one', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 4.5, updatedAt: NOW },
      { movieId: MOONLIGHT.id, rating: 3, updatedAt: NOW - 1 },
      { movieId: HEAT.id, rating: 4, updatedAt: NOW - 2 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT]));

    const removeArrival = await screen.findByRole('button', { name: 'Remove rating for Arrival' });
    removeArrival.focus();
    fireEvent.click(removeArrival);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove rating for Moonlight' }),
      ),
    );
  });

  it('moves focus to the previous rating after removing the last row', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 4.5, updatedAt: NOW },
      { movieId: MOONLIGHT.id, rating: 3, updatedAt: NOW - 1 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT]));

    const removeMoonlight = await screen.findByRole('button', {
      name: 'Remove rating for Moonlight',
    });
    removeMoonlight.focus();
    fireEvent.click(removeMoonlight);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove rating for Arrival' }),
      ),
    );
  });

  it('moves focus to the rated heading when the last rating is removed', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: ARRIVAL.id, rating: 4.5, updatedAt: NOW }]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const removeArrival = await screen.findByRole('button', { name: 'Remove rating for Arrival' });
    removeArrival.focus();
    fireEvent.click(removeArrival);

    await screen.findByText('No ratings yet. Rate a film in your library to tune the picks.');

    const heading = screen.getByRole('heading', { name: 'Rated films' });

    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('moves focus to the next watchlist row after removing one', async () => {
    const { profile, storage } = createProfile();

    storage.seedWatchlist([
      { movieId: HEAT.id, addedAt: NOW },
      { movieId: PADDINGTON_2.id, addedAt: NOW },
    ]);

    renderDashboard(profile, fakeLookup([HEAT, PADDINGTON_2]));

    const removeHeat = await screen.findByRole('button', { name: 'Remove Heat from watchlist' });
    removeHeat.focus();
    fireEvent.click(removeHeat);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Remove Paddington 2 from watchlist' }),
      ),
    );
  });

  it('shows history timestamps, sources, prompts, kinds and picks', async () => {
    const { profile, storage } = createProfile();

    storage.seedHistory([
      {
        id: 4,
        createdAt: new Date(2026, 10, 24, 15, 4).getTime(),
        kind: 'round',
        source: 'catalog',
        prompt: 'quiet thriller',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL), snapshot(MOONLIGHT)],
      },
      {
        id: 3,
        createdAt: new Date(2026, 10, 23, 9, 5).getTime(),
        kind: 'replace',
        source: 'watchlist',
        prompt: '',
        replacedMovieId: 2,
        movies: [snapshot(ARRIVAL), snapshot(HEAT)],
      },
      {
        id: 2,
        createdAt: new Date(2026, 10, 22, 20, 30).getTime(),
        kind: 'refresh',
        source: 'rewatch',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(MOONLIGHT), snapshot(THE_LIGHTHOUSE)],
      },
      {
        id: 1,
        createdAt: new Date(2026, 10, 21, 7, 0).getTime(),
        kind: 'round',
        source: 'paste',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(PADDINGTON_2)],
      },
    ]);

    renderDashboard(profile, fakeLookup([]));

    expect(await screen.findByText('24 Nov 2026, 15:04')).toBeTruthy();

    const recent = screen.getByRole('region', { name: 'Recent picks' });
    expect(within(recent).getByText('23 Nov 2026, 09:05')).toBeTruthy();
    expect(within(recent).getByText('Whole catalog')).toBeTruthy();
    expect(within(recent).getByText('Watchlist')).toBeTruthy();
    expect(within(recent).getByText('Rewatch shortlist')).toBeTruthy();
    expect(within(recent).getByText('Pasted list')).toBeTruthy();
    expect(within(recent).getByText('"quiet thriller"')).toBeTruthy();
    expect(within(recent).getAllByText('Round')).toHaveLength(2);
    expect(within(recent).getByText('Replacement')).toBeTruthy();
    expect(within(recent).getByText('Refresh')).toBeTruthy();
    expect(within(recent).getByText('Arrival · Moonlight')).toBeTruthy();
    expect(within(recent).getByText('Replaced Moonlight')).toBeTruthy();
  });

  it('resolves a replaced pick from loaded snapshots and falls back when unknown', async () => {
    const { profile, storage } = createProfile();

    storage.seedHistory([
      {
        id: 3,
        createdAt: NOW - 1000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: 1,
        movies: [snapshot(HEAT)],
      },
      {
        id: 2,
        createdAt: NOW - 2000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: 99,
        movies: [snapshot(MOONLIGHT)],
      },
      {
        id: 1,
        createdAt: NOW - 3000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL)],
      },
    ]);

    renderDashboard(profile, fakeLookup([]));

    expect(await screen.findByText('Replaced Arrival')).toBeTruthy();
    expect(screen.getByText('Replaced one pick')).toBeTruthy();
  });

  it('resolves a replacement from the newest older entry and ignores newer ones', async () => {
    const { profile, storage } = createProfile();

    function arrivalWithTitle(title: string): HistoryEntry['movies'][number] {
      return { ...snapshot(ARRIVAL), title };
    }

    storage.seedHistory([
      {
        id: 4,
        createdAt: NOW - 1000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [arrivalWithTitle('Newer Arrival')],
      },
      {
        id: 3,
        createdAt: NOW - 2000,
        kind: 'replace',
        source: 'catalog',
        prompt: '',
        replacedMovieId: ARRIVAL.id,
        movies: [snapshot(HEAT)],
      },
      {
        id: 2,
        createdAt: NOW - 3000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [arrivalWithTitle('Older Arrival')],
      },
      {
        id: 1,
        createdAt: NOW - 4000,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [arrivalWithTitle('Oldest Arrival')],
      },
    ]);

    renderDashboard(profile, fakeLookup([]));

    expect(await screen.findByText('Replaced Older Arrival')).toBeTruthy();
    expect(screen.queryByText('Replaced Newer Arrival')).toBeNull();
    expect(screen.queryByText('Replaced Oldest Arrival')).toBeNull();
    expect(screen.getByText('Newer Arrival')).toBeTruthy();
  });

  it('shows a quiet loading status until the profile data resolves', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    const loading = screen.getByText('Loading your dashboard…');

    expect(loading.getAttribute('role')).toBe('status');

    expect(
      await screen.findByText('No ratings yet. Rate a film in your library to tune the picks.'),
    ).toBeTruthy();
    expect(screen.queryByText('Loading your dashboard…')).toBeNull();
  });

  it('shows the three empty states for a new guest', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    expect(
      await screen.findByText('No ratings yet. Rate a film in your library to tune the picks.'),
    ).toBeTruthy();
    expect(screen.getByText('Nothing on your watchlist yet.')).toBeTruthy();
    expect(screen.getByText('No picks yet.')).toBeTruthy();
    expect(
      screen.getByText('No ratings yet, 0 rounds and 0 replacements in the last 7 days'),
    ).toBeTruthy();
  });

  it('shows the load error when the profile cannot be read', async () => {
    const { profile } = createProfile();

    vi.spyOn(profile, 'getRatings').mockRejectedValue(new Error('IndexedDB unavailable'));

    renderDashboard(profile, fakeLookup([]));

    expect(await screen.findByText('Could not load your dashboard. Try again.')).toBeTruthy();
  });
});

describe('Dashboard your data', () => {
  beforeEach(() => {
    download.mockClear();
  });

  function latestDownload(): { filename: string; contents: string; mimeType: string } {
    const call = download.mock.calls.at(-1);

    expect(call).toBeDefined();

    if (call === undefined) {
      throw new Error('expected a download call');
    }

    return { filename: call[0], contents: call[1], mimeType: call[2] };
  }

  it('disables the ratings export until a rating exists', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    const exportRatings = await screen.findByRole('button', { name: 'Export ratings (CSV)' });
    const exportBackup = screen.getByRole('button', { name: 'Export backup (JSON)' });

    expect(exportRatings.hasAttribute('disabled')).toBe(true);
    expect(exportBackup.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeTruthy();
  });

  it('exports an empty backup for a new guest', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    fireEvent.click(await screen.findByRole('button', { name: 'Export backup (JSON)' }));

    expect(await screen.findByText('Exported your backup.')).toBeTruthy();

    const backup = parseProfileBackup(latestDownload().contents);

    expect(backup.exportedAt).toBe(new Date(NOW).toISOString());
    expect(backup.ratings).toEqual([]);
    expect(backup.watched).toEqual([]);
    expect(backup.watchlist).toEqual([]);
    expect(backup.cooldowns).toEqual([]);
    expect(backup.history).toEqual([]);
  });

  it('downloads two ratings as a Letterboxd CSV without double-firing', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 4.5, updatedAt: NOW - 1000 },
      { movieId: 2, rating: 3, updatedAt: NOW - 2000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT]));

    const exportRatings = await screen.findByRole('button', { name: 'Export ratings (CSV)' });

    expect(exportRatings.hasAttribute('disabled')).toBe(false);

    fireEvent.click(exportRatings);
    fireEvent.click(exportRatings);

    expect(await screen.findByText('Exported 2 ratings.')).toBeTruthy();
    expect(download).toHaveBeenCalledTimes(1);

    const { filename, contents, mimeType } = latestDownload();

    expect(filename).toBe(`letterboxd-ratings-${isoDate(NOW)}.csv`);
    expect(mimeType).toBe('text/csv');
    expect(contents).toBe(
      [
        'Date,Name,Year,Letterboxd URI,Rating',
        `${isoDate(NOW - 1000)},Arrival,2016,,4.5`,
        `${isoDate(NOW - 2000)},Moonlight,2016,,3`,
      ].join('\n'),
    );
    expect(screen.getByRole('status').textContent).toBe('Exported 2 ratings.');
  });

  it('uses singular copy and names ratings whose films are missing from the catalog', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: 1, rating: 5, updatedAt: NOW - 1000 },
      { movieId: 98, rating: 2, updatedAt: NOW - 2000 },
      { movieId: 99, rating: 3, updatedAt: NOW - 3000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    fireEvent.click(await screen.findByRole('button', { name: 'Export ratings (CSV)' }));

    expect(
      await screen.findByText(
        'Exported 1 rating. 2 films could not be looked up and were left out.',
      ),
    ).toBeTruthy();

    const { contents } = latestDownload();

    expect(contents).toBe(
      ['Date,Name,Year,Letterboxd URI,Rating', `${isoDate(NOW - 1000)},Arrival,2016,,5`].join('\n'),
    );
  });

  it('downloads a backup that parses back with every seeded row and timestamp', async () => {
    const { profile, storage } = createProfile();
    const historyEntry: HistoryEntry = {
      id: 1,
      createdAt: NOW - 3000,
      kind: 'round',
      source: 'catalog',
      prompt: '',
      replacedMovieId: null,
      movies: [snapshot(ARRIVAL)],
    };

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW - 1000 }]);
    storage.seedWatched([{ movieId: 2, watchedAt: NOW - 2000 }]);
    storage.seedWatchlist([{ movieId: 3, addedAt: NOW - 2500 }]);
    storage.seedCooldowns([
      { movieId: 5, expiresAt: NOW - DAY_MS },
      { movieId: 4, expiresAt: NOW + DAY_MS },
    ]);
    storage.seedHistory([historyEntry]);

    renderDashboard(profile, fakeLookup([]));

    fireEvent.click(await screen.findByRole('button', { name: 'Export backup (JSON)' }));

    expect(await screen.findByText('Exported your backup.')).toBeTruthy();

    const { filename, contents, mimeType } = latestDownload();
    const backup = parseProfileBackup(contents);

    expect(filename).toBe(`movie-recommender-backup-${isoDate(NOW)}.json`);
    expect(mimeType).toBe('application/json');
    expect(backup.exportedAt).toBe(new Date(NOW).toISOString());
    expect(backup.ratings).toEqual([{ movieId: 1, rating: 4.5, updatedAt: NOW - 1000 }]);
    expect(backup.watched).toEqual([{ movieId: 2, watchedAt: NOW - 2000 }]);
    expect(backup.watchlist).toEqual([{ movieId: 3, addedAt: NOW - 2500 }]);
    expect(backup.cooldowns).toEqual([
      { movieId: 4, expiresAt: NOW + DAY_MS },
      { movieId: 5, expiresAt: NOW - DAY_MS },
    ]);
    expect(backup.history).toEqual([historyEntry]);
  });

  it('shows the ratings export error, skips the download and releases the guard', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const exportRatings = await screen.findByRole('button', { name: 'Export ratings (CSV)' });
    const exportBackup = screen.getByRole('button', { name: 'Export backup (JSON)' });

    const getRatings = vi.spyOn(profile, 'getRatings').mockRejectedValue(new Error('read failed'));

    expect(exportRatings.hasAttribute('disabled')).toBe(false);

    fireEvent.click(exportRatings);

    expect(await screen.findByText('Could not export your ratings. Try again.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Could not export your ratings. Try again.',
    );
    expect(download).not.toHaveBeenCalled();
    await waitFor(() => expect(exportRatings.hasAttribute('disabled')).toBe(false));
    expect(exportBackup.hasAttribute('disabled')).toBe(false);

    getRatings.mockRestore();
    fireEvent.click(exportRatings);

    expect(await screen.findByText('Exported 1 rating.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Exported 1 rating.');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('shows the backup export error, skips the download and releases the guard', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const exportRatings = await screen.findByRole('button', { name: 'Export ratings (CSV)' });
    const exportBackup = screen.getByRole('button', { name: 'Export backup (JSON)' });

    const getWatched = vi.spyOn(profile, 'getWatched').mockRejectedValue(new Error('read failed'));

    expect(exportBackup.hasAttribute('disabled')).toBe(false);

    fireEvent.click(exportBackup);

    expect(await screen.findByText('Could not export your backup. Try again.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Could not export your backup. Try again.');
    expect(download).not.toHaveBeenCalled();
    await waitFor(() => expect(exportBackup.hasAttribute('disabled')).toBe(false));
    expect(exportRatings.hasAttribute('disabled')).toBe(false);

    getWatched.mockRestore();
    fireEvent.click(exportBackup);

    expect(await screen.findByText('Exported your backup.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Exported your backup.');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('reveals the delete confirmation first and restores the button on cancel', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const clearAll = vi.spyOn(profile, 'clearAll');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete profile' }));

    expect(
      screen.getByText(
        'This deletes your ratings, watchlist, watched films, cooldowns and recommendation history on this device. It cannot be undone.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeTruthy();
    expect(clearAll).not.toHaveBeenCalled();
    await expect(profile.getRatings()).resolves.toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/This deletes your ratings/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete everything' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete profile' }));
    await expect(profile.getRatings()).resolves.toHaveLength(1);
  });

  it('deletes every profile row after confirmation and reloads the dashboard', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);
    storage.seedWatched([{ movieId: 2, watchedAt: NOW }]);
    storage.seedWatchlist([{ movieId: 3, addedAt: NOW }]);
    storage.seedCooldowns([{ movieId: 4, expiresAt: NOW + DAY_MS }]);
    storage.seedHistory([
      {
        id: 1,
        createdAt: NOW,
        kind: 'round',
        source: 'catalog',
        prompt: '',
        replacedMovieId: null,
        movies: [snapshot(ARRIVAL)],
      },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    const clearAll = vi.spyOn(profile, 'clearAll');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }));

    expect(await screen.findByText('Your profile was deleted.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Your profile was deleted.');
    expect(clearAll).toHaveBeenCalledTimes(1);

    await expect(profile.getRatings()).resolves.toEqual([]);
    await expect(profile.getWatched()).resolves.toEqual([]);
    await expect(profile.getWatchlist()).resolves.toEqual([]);
    await expect(profile.getCooldowns()).resolves.toEqual([]);
    await expect(profile.getHistory()).resolves.toEqual([]);

    const counts = Array.from(document.querySelectorAll('.dashboard__count')).map(
      (item) => item.textContent,
    );

    expect(counts).toEqual(['0 rated', '0 watched', '0 watchlisted', '0 cooling down']);
    expect(screen.queryByRole('button', { name: 'Delete everything' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeTruthy();
  });

  it('keeps the profile and shows the failure copy when deletion fails', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);
    vi.spyOn(profile, 'clearAll').mockRejectedValue(new Error('Quota exceeded'));

    renderDashboard(profile, fakeLookup([ARRIVAL]));

    fireEvent.click(await screen.findByRole('button', { name: 'Delete profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }));

    expect(await screen.findByText('Could not delete your profile. Try again.')).toBeTruthy();
    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 1, rating: 4.5, updatedAt: NOW },
    ]);
    expect(screen.getByRole('button', { name: 'Remove rating for Arrival' })).toBeTruthy();
  });
});
