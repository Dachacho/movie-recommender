import { tasteRequestSchema } from '@movie-recommender/shared';
import { describe, expect, it, vi } from 'vitest';
import { COOLDOWN_MS } from '../recommendationInput';
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

  it('stores a cooldown that expires seven days after the write', async () => {
    const { profile } = setup({ now: () => 1_700_000_000_000 });

    await expect(profile.setCooldown(42)).resolves.toEqual({
      movieId: 42,
      expiresAt: 1_700_000_000_000 + COOLDOWN_MS,
    });
    await expect(profile.getActiveCooldownIds()).resolves.toEqual([42]);
  });

  it('extends an existing cooldown instead of duplicating it', async () => {
    let now = 1_000;
    const { profile } = setup({ now: () => now });

    await profile.setCooldown(42);
    now = 2_000;
    await profile.setCooldown(42);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([42]);
    await expect(profile.cooldownsCount()).resolves.toBe(1);
  });

  it('returns only unexpired cooldowns, sorted ascending', async () => {
    const now = 10_000;
    const { profile, storage } = setup({ now: () => now });

    storage.seedCooldowns([
      { movieId: 9, expiresAt: now + 10 },
      { movieId: 3, expiresAt: now + 1 },
      { movieId: 4, expiresAt: now },
      { movieId: 5, expiresAt: now - 1 },
    ]);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([3, 9]);
  });

  it('skips malformed cooldown records and invalid movie ids', async () => {
    const now = 10_000;
    const { profile, storage } = setup({ now: () => now });

    storage.seedCooldowns([
      null,
      { movieId: 'not-a-number', expiresAt: now + 1 },
      { movieId: 6, expiresAt: -1 },
      { movieId: 7.5, expiresAt: now + 1 },
      { movieId: 8, expiresAt: now + 1 },
    ]);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([8]);

    await expect(profile.setCooldown(0)).rejects.toBeInstanceOf(GuestProfileValidationError);
    await expect(profile.setCooldown(1.5)).rejects.toBeInstanceOf(GuestProfileValidationError);
    await expect(profile.removeCooldown(-1)).rejects.toBeInstanceOf(GuestProfileValidationError);
  });

  it('removes a cooldown before it expires', async () => {
    const { profile } = setup({ now: () => 1_000 });

    await profile.setCooldown(42);
    await profile.removeCooldown(42);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);
    await expect(profile.hasCooldowns()).resolves.toBe(false);
  });

  it('counts only active, unique cooldowns', async () => {
    const now = 5_000;
    const { profile, storage } = setup({ now: () => now });

    storage.seedCooldowns([
      { movieId: 1, expiresAt: now + 1 },
      { movieId: 1, expiresAt: now + 2 },
      { movieId: 2, expiresAt: now + 1 },
      { movieId: 3, expiresAt: now },
    ]);

    await expect(profile.cooldownsCount()).resolves.toBe(2);
    await expect(profile.hasCooldowns()).resolves.toBe(true);
  });

  it('writes a batch of cooldowns in one storage operation with one shared expiry', async () => {
    const { profile, storage } = setup({ now: () => 1_000 });
    const batchSpy = vi.spyOn(storage, 'writeCooldowns');
    const singleSpy = vi.spyOn(storage, 'writeCooldown');

    const records = [
      { movieId: 1, expiresAt: 1_000 + COOLDOWN_MS },
      { movieId: 2, expiresAt: 1_000 + COOLDOWN_MS },
      { movieId: 4, expiresAt: 1_000 + COOLDOWN_MS },
    ];

    await expect(profile.setCooldowns([4, 1, 2, 1])).resolves.toEqual(records);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith(records);
    expect(singleSpy).not.toHaveBeenCalled();
    expect(profile.getVersion()).toBe(1);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([1, 2, 4]);
  });

  it('writes no cooldown records when one movie id in a batch is invalid', async () => {
    const { profile } = setup({ now: () => 1_000 });

    await expect(profile.setCooldowns([1, 0])).rejects.toBeInstanceOf(GuestProfileValidationError);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([]);
    expect(profile.getVersion()).toBe(0);
  });

  it('ignores an empty cooldown batch', async () => {
    const { profile } = setup({ now: () => 1_000 });

    await expect(profile.setCooldowns([])).resolves.toEqual([]);
    expect(profile.getVersion()).toBe(0);
  });

  it('replaces an existing cooldown row when a batch includes its movie id', async () => {
    let now = 1_000;
    const { profile } = setup({ now: () => now });

    await profile.setCooldown(1);
    now = 2_000;
    await profile.setCooldowns([1, 2]);

    await expect(profile.getActiveCooldownIds()).resolves.toEqual([1, 2]);
    await expect(profile.cooldownsCount()).resolves.toBe(2);
  });

  it('bumps its version when a cooldown is written or removed', async () => {
    const { profile } = setup({ now: () => 1_000 });

    await profile.setCooldown(1);
    expect(profile.getVersion()).toBe(1);

    await profile.removeCooldown(1);
    expect(profile.getVersion()).toBe(2);

    await profile.getActiveCooldownIds();
    await profile.cooldownsCount();
    await profile.hasCooldowns();

    expect(profile.getVersion()).toBe(2);
  });

  it('returns every rated movie id, beyond the 500-entry taste payload cap', async () => {
    const { profile, storage } = setup();
    const rows = Array.from({ length: 600 }, (_value, index) => ({
      movieId: index + 1,
      rating: 4,
      updatedAt: index,
    }));

    storage.seedRatings(rows);

    await expect(profile.getRatedIds()).resolves.toEqual(
      Array.from({ length: 600 }, (_value, index) => index + 1),
    );
    await expect(profile.ratingsPayload()).resolves.toHaveLength(500);
  });

  it('returns rated ids deduplicated, sorted and without malformed records', async () => {
    const { profile, storage } = setup();

    storage.seedRatings([
      { movieId: 9, rating: 4, updatedAt: 1 },
      { movieId: 2, rating: 3, updatedAt: 1 },
      { movieId: 9, rating: 5, updatedAt: 2 },
      { movieId: 'bad', rating: 3, updatedAt: 1 },
      null,
    ]);

    await expect(profile.getRatedIds()).resolves.toEqual([2, 9]);
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
