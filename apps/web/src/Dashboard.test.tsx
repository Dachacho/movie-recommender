import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import type { MovieLookup } from './movieLookup';
import { GuestProfile } from './profile/GuestProfile';
import { MemoryGuestProfileStorage } from './profile/memoryStorage';
import type { HistoryEntry } from './profile/schema';

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

  it('shows the three empty states for a new guest', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    expect(
      await screen.findByText('No ratings yet. Rate a film in your library to tune the picks.'),
    ).toBeTruthy();
    expect(screen.getByText('Nothing on your watchlist yet.')).toBeTruthy();
    expect(
      screen.getByText('No picks yet. Your recommendation rounds will appear here.'),
    ).toBeTruthy();
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
