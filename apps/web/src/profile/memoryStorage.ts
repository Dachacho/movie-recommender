import type { RatingRecord, WatchedRecord, WatchlistRecord } from './schema';
import type { GuestProfileStorage } from './storage';

function hasMovieId(row: unknown, movieId: number): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    'movieId' in row &&
    (row as { movieId?: unknown }).movieId === movieId
  );
}

/**
 * In-memory GuestProfileStorage used by tests. It deliberately stores raw
 * `unknown` rows so tests can seed malformed IndexedDB-like data.
 */
export class MemoryGuestProfileStorage implements GuestProfileStorage {
  private ratings: unknown[] = [];
  private watched: unknown[] = [];
  private watchlist: unknown[] = [];

  seedRatings(rows: unknown[]): void {
    this.ratings = [...rows];
  }

  seedWatched(rows: unknown[]): void {
    this.watched = [...rows];
  }

  seedWatchlist(rows: unknown[]): void {
    this.watchlist = [...rows];
  }

  async readRatings(): Promise<unknown[]> {
    return [...this.ratings];
  }

  async writeRating(record: RatingRecord): Promise<void> {
    this.ratings = [...this.ratings.filter((row) => !hasMovieId(row, record.movieId)), record];
  }

  async deleteRating(movieId: number): Promise<void> {
    this.ratings = this.ratings.filter((row) => !hasMovieId(row, movieId));
  }

  async readWatched(): Promise<unknown[]> {
    return [...this.watched];
  }

  async writeWatched(record: WatchedRecord): Promise<void> {
    this.watched = [...this.watched.filter((row) => !hasMovieId(row, record.movieId)), record];
  }

  async deleteWatched(movieId: number): Promise<void> {
    this.watched = this.watched.filter((row) => !hasMovieId(row, movieId));
  }

  async readWatchlist(): Promise<unknown[]> {
    return [...this.watchlist];
  }

  async writeWatchlist(record: WatchlistRecord): Promise<void> {
    this.watchlist = [...this.watchlist.filter((row) => !hasMovieId(row, record.movieId)), record];
  }

  async deleteWatchlist(movieId: number): Promise<void> {
    this.watchlist = this.watchlist.filter((row) => !hasMovieId(row, movieId));
  }
}
