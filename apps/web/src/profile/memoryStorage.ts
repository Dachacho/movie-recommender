import type {
  CooldownRecord,
  HistoryEntryInput,
  RatingRecord,
  WatchedRecord,
  WatchlistRecord,
} from './schema';
import type { GuestProfileStorage } from './storage';

function hasMovieId(row: unknown, movieId: number): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    'movieId' in row &&
    (row as { movieId?: unknown }).movieId === movieId
  );
}

function rowMovieId(row: unknown): number | null {
  if (typeof row !== 'object' || row === null || !('movieId' in row)) {
    return null;
  }

  const movieId = (row as { movieId?: unknown }).movieId;

  return typeof movieId === 'number' ? movieId : null;
}

function rowId(row: unknown): number | null {
  if (typeof row !== 'object' || row === null || !('id' in row)) {
    return null;
  }

  const id = (row as { id?: unknown }).id;

  return typeof id === 'number' ? id : null;
}

/**
 * In-memory GuestProfileStorage used by tests. It deliberately stores raw
 * `unknown` rows so tests can seed malformed IndexedDB-like data.
 */
export class MemoryGuestProfileStorage implements GuestProfileStorage {
  private ratings: unknown[] = [];
  private watched: unknown[] = [];
  private watchlist: unknown[] = [];
  private cooldowns: unknown[] = [];
  private history: unknown[] = [];
  private nextHistoryId = 1;

  seedRatings(rows: unknown[]): void {
    this.ratings = [...rows];
  }

  seedWatched(rows: unknown[]): void {
    this.watched = [...rows];
  }

  seedWatchlist(rows: unknown[]): void {
    this.watchlist = [...rows];
  }

  seedCooldowns(rows: unknown[]): void {
    this.cooldowns = [...rows];
  }

  seedHistory(rows: unknown[]): void {
    this.history = [...rows];
    const ids = rows.map(rowId).filter((id): id is number => id !== null);
    this.nextHistoryId = ids.length === 0 ? 1 : Math.max(...ids) + 1;
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

  async readCooldowns(): Promise<unknown[]> {
    return [...this.cooldowns];
  }

  async writeCooldown(record: CooldownRecord): Promise<void> {
    this.cooldowns = [...this.cooldowns.filter((row) => !hasMovieId(row, record.movieId)), record];
  }

  async writeCooldowns(records: CooldownRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const movieIds = new Set(records.map((record) => record.movieId));
    this.cooldowns = [
      ...this.cooldowns.filter((row) => {
        const movieId = rowMovieId(row);

        return movieId === null || !movieIds.has(movieId);
      }),
      ...records,
    ];
  }

  async deleteCooldown(movieId: number): Promise<void> {
    this.cooldowns = this.cooldowns.filter((row) => !hasMovieId(row, movieId));
  }

  async readHistory(): Promise<unknown[]> {
    return [...this.history];
  }

  async writeHistoryEntry(entry: HistoryEntryInput): Promise<number> {
    const id = this.nextHistoryId;
    this.nextHistoryId += 1;
    this.history = [...this.history, { ...entry, id }];

    return id;
  }

  async deleteHistoryEntry(id: number): Promise<void> {
    this.history = this.history.filter((row) => rowId(row) !== id);
  }

  async clearHistory(): Promise<void> {
    this.history = [];
  }
}
