import { tasteRequestSchema } from '@movie-recommender/shared';
import { describe, expect, it } from 'vitest';
import { GuestProfile, GuestProfileValidationError } from './GuestProfile';
import { MemoryGuestProfileStorage } from './memoryStorage';

function setup(options: { now?: () => number } = {}): {
  profile: GuestProfile;
  storage: MemoryGuestProfileStorage;
} {
  const storage = new MemoryGuestProfileStorage();
  const profile = new GuestProfile(storage, options.now === undefined ? {} : { now: options.now });

  return { profile, storage };
}

describe('GuestProfile', () => {
  it('stores a rating with an updatedAt timestamp and reads it back', async () => {
    const { profile } = setup({ now: () => 1_700_000_000_000 });

    const record = await profile.setRating(42, 4.5);

    expect(record).toEqual({ movieId: 42, rating: 4.5, updatedAt: 1_700_000_000_000 });
    await expect(profile.getRatings()).resolves.toEqual([record]);
  });

  it('upserts an existing rating with a newer timestamp', async () => {
    let now = 100;
    const { profile } = setup({ now: () => now });

    await profile.setRating(42, 2);
    now = 200;
    await profile.setRating(42, 3.5);

    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 42, rating: 3.5, updatedAt: 200 },
    ]);
  });

  it.each([0, 5.5, 4.2, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid rating value: %s',
    async (rating) => {
      const { profile } = setup();

      await expect(profile.setRating(42, rating)).rejects.toBeInstanceOf(
        GuestProfileValidationError,
      );
      await expect(profile.getRatings()).resolves.toEqual([]);
    },
  );

  it.each([0, -1, 1.5, 2_147_483_648])('rejects an invalid movie id: %s', async (movieId) => {
    const { profile } = setup();

    await expect(profile.setRating(movieId, 4)).rejects.toBeInstanceOf(GuestProfileValidationError);
    await expect(profile.setWatched(movieId)).rejects.toBeInstanceOf(GuestProfileValidationError);
    await expect(profile.addToWatchlist(movieId)).rejects.toBeInstanceOf(
      GuestProfileValidationError,
    );
  });

  it('removes a rating', async () => {
    const { profile } = setup();

    await profile.setRating(42, 4);
    await profile.removeRating(42);

    await expect(profile.getRatings()).resolves.toEqual([]);
  });

  it('stores and removes watched movies', async () => {
    const { profile } = setup({ now: () => 500 });

    await expect(profile.setWatched(7)).resolves.toEqual({ movieId: 7, watchedAt: 500 });
    await expect(profile.getWatchedIds()).resolves.toEqual([7]);

    await profile.removeWatched(7);

    await expect(profile.getWatchedIds()).resolves.toEqual([]);
  });

  it('stores and removes watchlist movies', async () => {
    const { profile } = setup({ now: () => 600 });

    await expect(profile.addToWatchlist(8)).resolves.toEqual({ movieId: 8, addedAt: 600 });
    await expect(profile.getWatchlistIds()).resolves.toEqual([8]);

    await profile.removeFromWatchlist(8);

    await expect(profile.getWatchlistIds()).resolves.toEqual([]);
  });

  it('builds a sorted, deduplicated ratings payload', async () => {
    const { profile, storage } = setup();

    storage.seedRatings([
      { movieId: 9, rating: 1, updatedAt: 10 },
      { movieId: 2, rating: 4.5, updatedAt: 10 },
      { movieId: 9, rating: 3, updatedAt: 20 },
      { movieId: 5, rating: 2.5, updatedAt: 10 },
    ]);

    const payload = await profile.ratingsPayload();

    expect(payload).toEqual([
      { movieId: 2, rating: 4.5 },
      { movieId: 5, rating: 2.5 },
      { movieId: 9, rating: 3 },
    ]);
    expect(tasteRequestSchema.safeParse({ ratings: payload }).success).toBe(true);
  });

  it('sorts watched and watchlist ids deterministically', async () => {
    const { profile, storage } = setup();

    storage.seedWatched([
      { movieId: 9, watchedAt: 1 },
      { movieId: 3, watchedAt: 2 },
    ]);
    storage.seedWatchlist([
      { movieId: 8, addedAt: 1 },
      { movieId: 4, addedAt: 2 },
    ]);

    await expect(profile.getWatchedIds()).resolves.toEqual([3, 9]);
    await expect(profile.getWatchlistIds()).resolves.toEqual([4, 8]);
  });

  it('skips malformed stored records instead of passing them through', async () => {
    const { profile, storage } = setup();

    storage.seedRatings([
      null,
      { movieId: 'not-a-number', rating: 4, updatedAt: 1 },
      { movieId: 1, rating: 4, updatedAt: 'not-a-timestamp' },
      { movieId: 2, rating: 3.5, updatedAt: 1 },
    ]);
    storage.seedWatched([undefined, { movieId: 3, watchedAt: 1.5 }, { movieId: 4, watchedAt: 2 }]);
    storage.seedWatchlist([{ movieId: 5 }, { movieId: 6, addedAt: 3 }]);

    await expect(profile.getRatings()).resolves.toEqual([
      { movieId: 2, rating: 3.5, updatedAt: 1 },
    ]);
    await expect(profile.getWatchedIds()).resolves.toEqual([4]);
    await expect(profile.getWatchlistIds()).resolves.toEqual([6]);
    await expect(profile.ratingsPayload()).resolves.toEqual([{ movieId: 2, rating: 3.5 }]);
  });

  it('limits the payload to 500 entries, breaking updatedAt ties by movieId', async () => {
    const { profile, storage } = setup();
    const rows = Array.from({ length: 501 }, (_value, index) => ({
      movieId: index + 1,
      rating: 4,
      updatedAt: 1,
    }));

    storage.seedRatings(rows);

    const payload = await profile.ratingsPayload();

    expect(payload).toHaveLength(500);
    expect(payload[0]).toEqual({ movieId: 1, rating: 4 });
    expect(payload[499]).toEqual({ movieId: 500, rating: 4 });
    expect(tasteRequestSchema.safeParse({ ratings: payload }).success).toBe(true);
  });

  it('keeps the 500 most recently updated ratings, then sorts them by movieId', async () => {
    const { profile, storage } = setup();
    const rows = Array.from({ length: 501 }, (_value, index) => ({
      movieId: index + 1,
      rating: 4,
      updatedAt: index,
    }));

    storage.seedRatings(rows);

    const payload = await profile.ratingsPayload();

    expect(payload).toHaveLength(500);
    expect(payload[0]).toEqual({ movieId: 2, rating: 4 });
    expect(payload[499]).toEqual({ movieId: 501, rating: 4 });
  });

  it('bumps its version on every write and keeps it stable on reads', async () => {
    const { profile } = setup();

    await expect(profile.ratingsCount()).resolves.toBe(0);
    await expect(profile.hasRatings()).resolves.toBe(false);
    expect(profile.getVersion()).toBe(0);

    await profile.setRating(1, 4);
    expect(profile.getVersion()).toBe(1);

    await profile.setWatched(2);
    expect(profile.getVersion()).toBe(2);

    await profile.addToWatchlist(3);
    expect(profile.getVersion()).toBe(3);

    await profile.removeRating(1);
    expect(profile.getVersion()).toBe(4);

    await profile.removeWatched(2);
    expect(profile.getVersion()).toBe(5);

    await profile.removeFromWatchlist(3);
    expect(profile.getVersion()).toBe(6);

    await profile.getRatings();
    await profile.getWatchedIds();
    await profile.getWatchlistIds();
    await profile.ratingsPayload();
    await profile.ratingsCount();
    await profile.hasRatings();

    expect(profile.getVersion()).toBe(6);
  });

  it('counts only valid, unique ratings', async () => {
    const { profile, storage } = setup();

    storage.seedRatings([
      { movieId: 1, rating: 4, updatedAt: 1 },
      { movieId: 1, rating: 5, updatedAt: 2 },
      { movieId: 2, rating: 3, updatedAt: 1 },
      { movieId: 'bad', rating: 3, updatedAt: 1 },
    ]);

    await expect(profile.ratingsCount()).resolves.toBe(2);
    await expect(profile.hasRatings()).resolves.toBe(true);
  });
});
