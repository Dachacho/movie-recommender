import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { MovieCard } from '@movie-recommender/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard, type DashboardTab } from './Dashboard';
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

const SPRAWL_GENRES = Array.from({ length: 14 }, (_value, index) => `Genre ${String(index + 1)}`);

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

function dashboardElement(
  profile: GuestProfile,
  lookup: MovieLookup,
  tab: DashboardTab,
): ReactElement {
  return <Dashboard profile={profile} tab={tab} lookup={lookup} now={() => NOW} />;
}

function renderDashboard(
  profile: GuestProfile,
  lookup: MovieLookup,
  tab: DashboardTab = 'taste',
): ReturnType<typeof render> {
  return render(dashboardElement(profile, lookup, tab));
}

function sprawlMovie(id: number): MovieCard {
  return { ...ARRIVAL, id, title: `Genre Sprawl ${String(id)}`, genres: SPRAWL_GENRES };
}

describe('Dashboard', () => {
  it('shows distinct counts, the mean rating, the activity window and a library link', async () => {
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

    const libraryLink = screen.getByRole('link', { name: 'Open your library' });
    expect(libraryLink.getAttribute('href')).toBe('#library/rated');
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

    renderDashboard(profile, fakeLookup([]), 'activity');

    const recent = await screen.findByRole('region', { name: 'Recent picks' });
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

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT]), 'breakdown');

    const spread = await screen.findByRole('region', { name: 'Rating spread' });
    const rows = within(spread).getAllByRole('listitem');

    expect(rows).toHaveLength(10);

    const labels = ['½ star:', '1 star:', '1½ stars:', '2 stars:', '2½ stars:'];
    const upperLabels = ['3 stars:', '3½ stars:', '4 stars:', '4½ stars:', '5 stars:'];

    for (const label of [...labels, ...upperLabels]) {
      expect(within(spread).getByText(label)).toBeTruthy();
    }

    const fiveStars = within(spread).getByText('5 stars:').closest('li');
    expect(fiveStars?.textContent).toContain('2 rated films');
    expect(fiveStars?.querySelector<HTMLElement>('.dashboard__histogram-bar')?.style.width).toBe(
      '100%',
    );

    const fourAndAHalf = within(spread).getByText('4½ stars:').closest('li');
    expect(fourAndAHalf?.textContent).toContain('1 rated film');

    const halfStar = within(spread).getByText('½ star:').closest('li');
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

  it('maps every rated film into the constellation and its all-genre tables', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 5, updatedAt: NOW - 1000 },
      { movieId: MOONLIGHT.id, rating: 4, updatedAt: NOW - 2000 },
      { movieId: HEAT.id, rating: 3, updatedAt: NOW - 3000 },
      { movieId: PADDINGTON_2.id, rating: 2, updatedAt: NOW - 4000 },
      { movieId: 5, rating: 4, updatedAt: NOW - 5000 },
      { movieId: 6, rating: 4, updatedAt: NOW - 6000 },
    ]);

    const baseLookup = fakeLookup([ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2]);
    const resolvedIds: number[][] = [];
    const lookup: MovieLookup = {
      resolveMany: async (ids) => {
        resolvedIds.push([...ids]);

        return baseLookup.resolveMany(ids);
      },
    };

    renderDashboard(profile, lookup);

    const taste = await screen.findByRole('region', { name: 'Taste constellation' });

    expect(await within(taste).findByText('4 of 6 rated films · mean 3.5')).toBeTruthy();
    expect(within(taste).getByText('Liked')).toBeTruthy();
    expect(within(taste).getByText('Neutral')).toBeTruthy();
    expect(within(taste).getByText('Disliked')).toBeTruthy();
    expect(taste.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(within(taste).getByText('Read as a table'));

    const table = within(taste).getByRole('table', {
      name: 'All genres from 4 of 6 rated films with genres.',
    });
    const rows = within(table).getAllByRole('row');
    const dramaRow = within(table).getByRole('rowheader', { name: 'Drama' }).closest('tr');

    expect(rows).toHaveLength(6);
    expect(dramaRow?.textContent).toContain('3');
    expect(dramaRow?.textContent).toContain('4.0');
    expect(dramaRow?.textContent).toContain('+1.5');

    const edgesTable = within(taste).getByRole('table', {
      name: 'Co-occurring genres across all genres from 4 of 6 rated films with genres.',
    });
    const edgeRow = within(edgesTable)
      .getByRole('rowheader', { name: 'Crime + Drama' })
      .closest('tr');

    expect(within(edgesTable).getByRole('columnheader', { name: 'Genres' })).toBeTruthy();
    expect(within(edgesTable).getByRole('columnheader', { name: 'Films' })).toBeTruthy();
    expect(edgeRow?.textContent).toContain('1');

    await waitFor(() => expect(resolvedIds).toContainEqual([1, 2, 3, 4, 5, 6]));
  });

  it('renders genre affinity bars for every rated film genre', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 5, updatedAt: NOW - 1000 },
      { movieId: MOONLIGHT.id, rating: 4, updatedAt: NOW - 2000 },
      { movieId: HEAT.id, rating: 3, updatedAt: NOW - 3000 },
      { movieId: PADDINGTON_2.id, rating: 2, updatedAt: NOW - 4000 },
      { movieId: 5, rating: 4, updatedAt: NOW - 5000 },
      { movieId: 6, rating: 4, updatedAt: NOW - 6000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2]), 'breakdown');

    const bars = await screen.findByRole('region', { name: 'Genre affinity' });

    await within(bars).findByText('Science Fiction');

    const barRows = within(bars).getAllByRole('listitem');

    expect(barRows.map((row) => row.querySelector('.genre-affinity__genre')?.textContent)).toEqual([
      'Science Fiction',
      'Drama',
      'Crime',
      'Comedy',
      'Family',
    ]);
    expect(barRows[0]?.textContent).toContain('1 film · 5.0 avg');
    expect(barRows[0]?.querySelector('.genre-affinity__bar--positive')).toBeTruthy();
    expect(barRows[4]?.querySelector('.genre-affinity__bar--negative')).toBeTruthy();
  });

  it('scales genre bars against ±2.5 and prints the signed affinity', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 4, updatedAt: NOW - 1000 },
      { movieId: MOONLIGHT.id, rating: 3, updatedAt: NOW - 2000 },
      { movieId: HEAT.id, rating: 2, updatedAt: NOW - 3000 },
      { movieId: PADDINGTON_2.id, rating: 2.5, updatedAt: NOW - 4000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT, HEAT, PADDINGTON_2]), 'breakdown');

    const bars = await screen.findByRole('region', { name: 'Genre affinity' });
    const scienceFiction = await within(bars).findByText('Science Fiction');
    const scienceFictionRow = scienceFiction.closest('li');
    const crime = within(bars).getByText('Crime').closest('li');
    const family = within(bars).getByText('Family').closest('li');

    expect(within(bars).getByText('−2.5 · neutral · +2.5')).toBeTruthy();
    expect(
      scienceFictionRow?.querySelector<HTMLElement>('.genre-affinity__affinity')?.textContent,
    ).toBe('+1.5');
    expect(scienceFictionRow?.querySelector<HTMLElement>('.genre-affinity__bar')?.style.width).toBe(
      '60%',
    );
    expect(crime?.querySelector<HTMLElement>('.genre-affinity__affinity')?.textContent).toBe(
      '−0.5',
    );
    expect(crime?.querySelector<HTMLElement>('.genre-affinity__bar')?.style.width).toBe('20%');
    expect(family?.querySelector<HTMLElement>('.genre-affinity__affinity')?.textContent).toBe(
      '0.0',
    );
    expect(family?.querySelector<HTMLElement>('.genre-affinity__bar')?.style.width).toBe('0%');
  });

  it('reports the kept genre cap and lists every genre in the constellation tables', async () => {
    const { profile, storage } = createProfile();
    const movies = [sprawlMovie(9), sprawlMovie(10), sprawlMovie(11)];

    storage.seedRatings([
      { movieId: 9, rating: 4, updatedAt: NOW - 1000 },
      { movieId: 10, rating: 4, updatedAt: NOW - 2000 },
      { movieId: 11, rating: 4, updatedAt: NOW - 3000 },
    ]);

    renderDashboard(profile, fakeLookup(movies));

    const taste = await screen.findByRole('region', { name: 'Taste constellation' });

    expect(await within(taste).findByText('3 films · mean 4.0 · top 12 of 14 genres')).toBeTruthy();
    expect(taste.querySelectorAll('.taste-node__hit')).toHaveLength(12);

    fireEvent.click(within(taste).getByText('Read as a table'));

    const genreTable = within(taste).getByRole('table', {
      name: 'All 14 genres from your rated films; the constellation plots the top 12.',
    });

    expect(within(genreTable).getAllByRole('row')).toHaveLength(15);

    const edgeTable = within(taste).getByRole('table', {
      name: 'Co-occurring genres across all 14 genres from your rated films; the constellation draws the pairs among its top 12 nodes.',
    });

    expect(within(edgeTable).getAllByRole('row')).toHaveLength(25);
    expect(within(edgeTable).getByRole('rowheader', { name: 'Genre 1 + Genre 9' })).toBeTruthy();
  });

  it('draws affinity bars for every genre, not just the top 12', async () => {
    const { profile, storage } = createProfile();
    const movies = [sprawlMovie(9), sprawlMovie(10), sprawlMovie(11)];

    storage.seedRatings([
      { movieId: 9, rating: 4, updatedAt: NOW - 1000 },
      { movieId: 10, rating: 4, updatedAt: NOW - 2000 },
      { movieId: 11, rating: 4, updatedAt: NOW - 3000 },
    ]);

    renderDashboard(profile, fakeLookup(movies), 'breakdown');

    const bars = await screen.findByRole('region', { name: 'Genre affinity' });

    await within(bars).findByText('Genre 14');

    const barRows = within(bars).getAllByRole('listitem');

    expect(barRows).toHaveLength(14);
    expect(within(bars).getByText('Genre 12')).toBeTruthy();
  });

  it('invalidates missing taste ids once and merges the retry', async () => {
    const { profile, storage } = createProfile();
    const recovered: MovieCard = {
      ...MOONLIGHT,
      id: 99,
      title: 'Recovered Film',
      genres: ['Drama'],
    };

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 4, updatedAt: NOW - 1000 },
      { movieId: recovered.id, rating: 3, updatedAt: NOW - 2000 },
    ]);

    let recoveredAvailable = false;
    const invalidate = vi.fn();
    const lookup: MovieLookup = {
      resolveMany: async (ids) => {
        const byId = new Map<number, MovieCard | null>([
          [ARRIVAL.id, ARRIVAL],
          [recovered.id, recoveredAvailable ? recovered : null],
        ]);

        return new Map(ids.map((movieId) => [movieId, byId.get(movieId) ?? null]));
      },
      invalidate: (ids) => {
        invalidate([...ids]);
        recoveredAvailable = true;
      },
    };

    renderDashboard(profile, lookup);

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith([recovered.id]));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('2 films · mean 3.5')).toBeTruthy();
    expect(screen.queryByText('1 of 2 rated films · mean 3.5')).toBeNull();
  });

  it('keeps the constellation loading while the all-ratings lookup is pending', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 5, updatedAt: NOW - 1000 },
      { movieId: MOONLIGHT.id, rating: 4, updatedAt: NOW - 2000 },
      { movieId: HEAT.id, rating: 3, updatedAt: NOW - 3000 },
      { movieId: 8, rating: 4, updatedAt: NOW - 4000 },
    ]);

    const baseLookup = fakeLookup([ARRIVAL, MOONLIGHT, HEAT]);
    const lookup: MovieLookup = {
      resolveMany: (ids) =>
        ids.includes(8)
          ? new Promise(() => {
              // The taste pass stays pending; the counts must not wait for it.
            })
          : baseLookup.resolveMany(ids),
    };

    renderDashboard(profile, lookup);

    const taste = await screen.findByRole('region', { name: 'Taste constellation' });

    expect(within(taste).getByRole('status').textContent).toBe('Placing your genres…');
  });

  it('shows a composed taste empty state with a library link', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]));

    const taste = await screen.findByRole('region', { name: 'Taste constellation' });
    const link = await within(taste).findByRole('link', { name: 'Find films to rate' });

    expect(link.getAttribute('href')).toBe('#library/find');
    expect(within(taste).getByText('Your constellation has no genres yet.')).toBeTruthy();
  });

  it('shows the genre-affinity empty state on the breakdown tab', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]), 'breakdown');

    const bars = await screen.findByRole('region', { name: 'Genre affinity' });
    expect(
      await within(bars).findByText('Rate a few films and their genres will line up here.'),
    ).toBeTruthy();
  });

  it('asks for another rating before drawing a sparse constellation', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([
      { movieId: ARRIVAL.id, rating: 5, updatedAt: NOW - 1000 },
      { movieId: MOONLIGHT.id, rating: 4, updatedAt: NOW - 2000 },
    ]);

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT]));

    const taste = await screen.findByRole('region', { name: 'Taste constellation' });

    expect(await within(taste).findByText('The constellation needs another point.')).toBeTruthy();
    expect(
      within(taste).getByText('Rate 1 more film to give the constellation enough points to draw.'),
    ).toBeTruthy();
    expect(within(taste).queryByText('Read as a table')).toBeNull();
    expect(taste.querySelector('svg')).toBeNull();
  });

  it('renders only the active tab and keeps the removed library lists off the dashboard', async () => {
    const { profile, storage } = createProfile();
    const lookup = fakeLookup([ARRIVAL]);

    storage.seedRatings([{ movieId: ARRIVAL.id, rating: 4, updatedAt: NOW }]);

    const { rerender } = renderDashboard(profile, lookup);

    expect(await screen.findByRole('region', { name: 'Taste constellation' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.dashboard__count')).toHaveLength(4));
    expect(screen.queryByRole('region', { name: 'Rating spread' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent picks' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recently rated films' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Watchlist' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove rating for/ })).toBeNull();

    rerender(dashboardElement(profile, lookup, 'breakdown'));

    expect(screen.getByRole('region', { name: 'Rating spread' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Genre affinity' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Taste constellation' })).toBeNull();
    expect(document.querySelectorAll('.dashboard__count')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Recent picks' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data' })).toBeNull();

    rerender(dashboardElement(profile, lookup, 'activity'));

    expect(screen.getByRole('region', { name: 'Recent picks' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Rating spread' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Taste constellation' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your data' })).toBeNull();

    rerender(dashboardElement(profile, lookup, 'data'));

    expect(screen.getByRole('region', { name: 'Your data' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Recent picks' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Rating spread' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Taste constellation' })).toBeNull();
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

    renderDashboard(profile, fakeLookup([]), 'activity');

    expect(await screen.findByText('24 Nov 2026, 15:04')).toBeTruthy();

    const recent = screen.getByRole('region', { name: 'Recent picks' });
    expect(within(recent).getByText('23 Nov 2026, 09:05')).toBeTruthy();
    expect(within(recent).getByText('The whole catalog')).toBeTruthy();
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

    renderDashboard(profile, fakeLookup([]), 'activity');

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

    renderDashboard(profile, fakeLookup([]), 'activity');

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
      await screen.findByText('No ratings yet, 0 rounds and 0 replacements in the last 7 days'),
    ).toBeTruthy();
    expect(screen.queryByText('Loading your dashboard…')).toBeNull();
  });

  it('shows the empty states for a new guest across the tabs', async () => {
    const { profile } = createProfile();
    const lookup = fakeLookup([]);

    const { rerender } = renderDashboard(profile, lookup);

    expect(
      await screen.findByText('No ratings yet, 0 rounds and 0 replacements in the last 7 days'),
    ).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('.dashboard__count')).map((item) => item.textContent),
    ).toEqual(['0 rated', '0 watched', '0 watchlisted', '0 cooling down']);

    rerender(dashboardElement(profile, lookup, 'activity'));

    expect(screen.getByText('No picks yet.')).toBeTruthy();
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

    renderDashboard(profile, fakeLookup([]), 'data');

    const exportRatings = await screen.findByRole('button', { name: 'Export ratings (CSV)' });
    const exportBackup = screen.getByRole('button', { name: 'Export backup (JSON)' });

    expect(exportRatings.hasAttribute('disabled')).toBe(true);
    expect(exportBackup.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeTruthy();
  });

  it('exports an empty backup for a new guest', async () => {
    const { profile } = createProfile();

    renderDashboard(profile, fakeLookup([]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL, MOONLIGHT]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

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

    renderDashboard(profile, fakeLookup([]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

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

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

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

    expect(screen.queryByRole('button', { name: 'Delete everything' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeTruthy();
  });

  it('keeps the profile and shows the failure copy when deletion fails', async () => {
    const { profile, storage } = createProfile();

    storage.seedRatings([{ movieId: 1, rating: 4.5, updatedAt: NOW }]);
    vi.spyOn(profile, 'clearAll').mockRejectedValue(new Error('Quota exceeded'));

    renderDashboard(profile, fakeLookup([ARRIVAL]), 'data');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }));

    expect(await screen.findByText('Could not delete your profile. Try again.')).toBeTruthy();
    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 1, rating: 4.5, updatedAt: NOW },
    ]);
    expect(
      screen.getByRole('button', { name: 'Export ratings (CSV)' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});
