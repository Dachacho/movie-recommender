import type { MovieCard } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import { GuestProfile, GuestProfileValidationError, type RecordRoundInput } from './GuestProfile';
import { MemoryGuestProfileStorage } from './memoryStorage';
import { MAX_HISTORY_ROUNDS, type HistoryEntry } from './schema';

function setup(options: { now?: () => number } = {}): {
  profile: GuestProfile;
  storage: MemoryGuestProfileStorage;
} {
  const storage = new MemoryGuestProfileStorage();
  const profile = new GuestProfile(storage, options.now === undefined ? {} : { now: options.now });

  return { profile, storage };
}

function movieCard(id: number, overrides: Partial<MovieCard> = {}): MovieCard {
  return {
    id,
    title: `Movie ${id}`,
    releaseYear: 2000,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: `/poster-${id}.jpg`,
    voteAverage: null,
    ...overrides,
  };
}

function roundInput(overrides: Partial<RecordRoundInput> = {}): RecordRoundInput {
  return {
    kind: 'round',
    source: 'catalog',
    prompt: '',
    replacedMovieId: null,
    movies: [movieCard(1)],
    ...overrides,
  };
}

function snapshot(id: number): HistoryEntry['movies'][number] {
  return { id, title: `Movie ${id}`, releaseYear: 2000, posterPath: null };
}

function historyEntry(id: number, createdAt = 1): HistoryEntry {
  return {
    id,
    createdAt,
    kind: 'round',
    source: 'catalog',
    prompt: '',
    replacedMovieId: null,
    movies: [snapshot(id)],
  };
}

describe('GuestProfile recommendation history', () => {
  it('records a round with a storage-assigned id and movie snapshots', async () => {
    const { profile } = setup({ now: () => 1_700_000_000_000 });

    const entry = await profile.recordRound({
      kind: 'replace',
      source: 'watchlist',
      prompt: 'tense sci-fi',
      replacedMovieId: 7,
      movies: [
        movieCard(10, { title: 'Arrival', releaseYear: 2016, posterPath: '/arrival.jpg' }),
        movieCard(11, { releaseYear: null, posterPath: null }),
      ],
    });

    expect(entry).toEqual({
      id: 1,
      createdAt: 1_700_000_000_000,
      kind: 'replace',
      source: 'watchlist',
      prompt: 'tense sci-fi',
      replacedMovieId: 7,
      movies: [
        { id: 10, title: 'Arrival', releaseYear: 2016, posterPath: '/arrival.jpg' },
        { id: 11, title: 'Movie 11', releaseYear: null, posterPath: null },
      ],
    });
    await expect(profile.getHistory()).resolves.toEqual([entry]);
  });

  const INVALID_ROUNDS: readonly { label: string; input: RecordRoundInput }[] = [
    { label: 'no movies', input: roundInput({ movies: [] }) },
    {
      label: 'more than four movies',
      input: roundInput({ movies: [1, 2, 3, 4, 5].map((id) => movieCard(id)) }),
    },
    {
      label: 'an unsupported kind',
      input: roundInput({ kind: 'other' as RecordRoundInput['kind'] }),
    },
    {
      label: 'an unsupported source',
      input: roundInput({ source: 'list' as RecordRoundInput['source'] }),
    },
    {
      label: 'a prompt longer than 300 characters',
      input: roundInput({ prompt: 'x'.repeat(301) }),
    },
    { label: 'an invalid movie id', input: roundInput({ movies: [movieCard(0)] }) },
    { label: 'an invalid replaced movie id', input: roundInput({ replacedMovieId: 0 }) },
  ];

  it.each(INVALID_ROUNDS)('rejects $label and writes nothing', async ({ input }) => {
    const { profile, storage } = setup();

    await expect(profile.recordRound(input)).rejects.toBeInstanceOf(GuestProfileValidationError);
    await expect(profile.getHistory()).resolves.toEqual([]);
    await expect(storage.readHistory()).resolves.toEqual([]);
    expect(profile.getVersion()).toBe(0);
  });

  it('trims history to the newest MAX_HISTORY_ROUNDS entries', async () => {
    const { profile, storage } = setup();

    for (let index = 0; index < MAX_HISTORY_ROUNDS + 2; index += 1) {
      await profile.recordRound(roundInput({ movies: [movieCard(index + 1)] }));
    }

    await expect(storage.readHistory()).resolves.toHaveLength(MAX_HISTORY_ROUNDS);

    const history = await profile.getHistory(MAX_HISTORY_ROUNDS + 10);

    expect(history).toHaveLength(MAX_HISTORY_ROUNDS);
    expect(history[0]?.id).toBe(MAX_HISTORY_ROUNDS + 2);
    expect(history.at(-1)?.id).toBe(3);
  });

  it('returns history newest first and applies the limit', async () => {
    const { profile } = setup();

    for (let index = 1; index <= 3; index += 1) {
      await profile.recordRound(roundInput({ movies: [movieCard(index)] }));
    }

    const history = await profile.getHistory(2);

    expect(history.map((entry) => entry.id)).toEqual([3, 2]);
  });

  it('defaults to the 50 newest rounds', async () => {
    const { profile } = setup();

    for (let index = 0; index < 55; index += 1) {
      await profile.recordRound(roundInput());
    }

    const history = await profile.getHistory();

    expect(history).toHaveLength(50);
    expect(history[0]?.id).toBe(55);
    expect(history.at(-1)?.id).toBe(6);
  });

  it('skips malformed stored history rows', async () => {
    const { profile, storage } = setup();

    storage.seedHistory([
      null,
      { ...historyEntry(1), id: 'not-a-number' },
      { ...historyEntry(2), movies: [] },
      { ...historyEntry(3), source: 'api' },
      historyEntry(5, 20),
      historyEntry(4, 10),
    ]);

    await expect(profile.getHistory()).resolves.toEqual([historyEntry(5, 20), historyEntry(4, 10)]);
  });

  it('clears all history', async () => {
    const { profile, storage } = setup();

    await profile.recordRound(roundInput());
    await profile.recordRound(roundInput());
    await profile.clearHistory();

    await expect(profile.getHistory()).resolves.toEqual([]);
    await expect(storage.readHistory()).resolves.toEqual([]);
  });

  it('does not bump the taste-cache version when history changes', async () => {
    const { profile } = setup();

    await profile.setRating(1, 4);
    expect(profile.getVersion()).toBe(1);

    await profile.recordRound(roundInput());
    expect(profile.getVersion()).toBe(1);

    await profile.clearHistory();
    expect(profile.getVersion()).toBe(1);
  });
});
