import type { MovieCard } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import { GuestProfile, type RecordRoundInput } from './GuestProfile';
import { MemoryGuestProfileStorage } from './memoryStorage';

function setup(): { profile: GuestProfile; storage: MemoryGuestProfileStorage } {
  const storage = new MemoryGuestProfileStorage();
  const profile = new GuestProfile(storage);

  return { profile, storage };
}

function movieCard(id: number): MovieCard {
  return {
    id,
    title: `Movie ${id}`,
    releaseYear: 2000,
    runtime: null,
    overview: null,
    genres: [],
    director: null,
    cast: [],
    posterPath: null,
    voteAverage: null,
  };
}

function roundInput(): RecordRoundInput {
  return {
    kind: 'round',
    source: 'catalog',
    prompt: '',
    replacedMovieId: null,
    movies: [movieCard(1)],
  };
}

async function seedProfile(profile: GuestProfile): Promise<void> {
  await profile.setRating(1, 4.5);
  await profile.setWatched(2);
  await profile.addToWatchlist(3);
  await profile.setCooldown(4);
  await profile.recordRound(roundInput());
}

class RejectingClearStorage extends MemoryGuestProfileStorage {
  override async clearAll(): Promise<void> {
    throw new Error('clear failed');
  }
}

describe('GuestProfile.clearAll', () => {
  it('empties all five tables and bumps the version once', async () => {
    const { profile, storage } = setup();

    await seedProfile(profile);

    expect(profile.getVersion()).toBe(4);

    await profile.clearAll();

    expect(profile.getVersion()).toBe(5);
    await expect(storage.readRatings()).resolves.toEqual([]);
    await expect(storage.readWatched()).resolves.toEqual([]);
    await expect(storage.readWatchlist()).resolves.toEqual([]);
    await expect(storage.readCooldowns()).resolves.toEqual([]);
    await expect(storage.readHistory()).resolves.toEqual([]);
    await expect(profile.getRatings()).resolves.toEqual([]);
    await expect(profile.getHistory()).resolves.toEqual([]);
  });

  it('leaves data and the version intact when storage rejects the clear', async () => {
    const storage = new RejectingClearStorage();
    const profile = new GuestProfile(storage);

    await seedProfile(profile);

    const versionBefore = profile.getVersion();

    await expect(profile.clearAll()).rejects.toThrow('clear failed');

    expect(profile.getVersion()).toBe(versionBefore);
    await expect(storage.readRatings()).resolves.toHaveLength(1);
    await expect(storage.readWatched()).resolves.toHaveLength(1);
    await expect(storage.readWatchlist()).resolves.toHaveLength(1);
    await expect(storage.readCooldowns()).resolves.toHaveLength(1);
    await expect(storage.readHistory()).resolves.toHaveLength(1);
  });
});
