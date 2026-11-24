import { describe, expect, it, vi, type Mock } from 'vitest';
import type { GuestProfileDB } from './db';
import { createDexieStorage } from './storage';

interface TableStub {
  toArray: Mock<() => Promise<unknown[]>>;
  put: Mock<(record: unknown) => Promise<void>>;
  delete: Mock<(key: number) => Promise<void>>;
  bulkPut: Mock<(records: unknown[]) => Promise<void>>;
  add: Mock<(record: unknown) => Promise<number>>;
  clear: Mock<() => Promise<void>>;
}

interface DatabaseStub {
  ratings: TableStub;
  watched: TableStub;
  watchlist: TableStub;
  cooldowns: TableStub;
  history: TableStub;
  transaction: Mock<
    (mode: string, tables: readonly TableStub[], scope: () => Promise<void>) => Promise<void>
  >;
}

interface DatabaseFixture {
  db: DatabaseStub;
  tables: readonly TableStub[];
  asGuestProfileDB: () => GuestProfileDB;
}

function tableStub(): TableStub {
  return {
    toArray: vi.fn<() => Promise<unknown[]>>(async () => []),
    put: vi.fn<(record: unknown) => Promise<void>>(async () => {}),
    delete: vi.fn<(key: number) => Promise<void>>(async () => {}),
    bulkPut: vi.fn<(records: unknown[]) => Promise<void>>(async () => {}),
    add: vi.fn<(record: unknown) => Promise<number>>(async () => 1),
    clear: vi.fn<() => Promise<void>>(async () => {}),
  };
}

function createDatabaseFixture(): DatabaseFixture {
  const ratings = tableStub();
  const watched = tableStub();
  const watchlist = tableStub();
  const cooldowns = tableStub();
  const history = tableStub();
  const tables = [ratings, watched, watchlist, cooldowns, history] as const;

  const db: DatabaseStub = {
    ratings,
    watched,
    watchlist,
    cooldowns,
    history,
    transaction: vi.fn<
      (mode: string, tableList: readonly TableStub[], scope: () => Promise<void>) => Promise<void>
    >(async (_mode, _tables, scope) => {
      await scope();
    }),
  };

  return {
    db,
    tables,
    // The adapter only uses the five tables and `transaction`. Real Dexie
    // Table instances cannot be built without IndexedDB, so the stub stands
    // in for GuestProfileDB behind this single documented cast.
    asGuestProfileDB: () => db as unknown as GuestProfileDB,
  };
}

describe('createDexieStorage clearAll', () => {
  it('runs one read-write transaction over exactly the five profile tables', async () => {
    const fixture = createDatabaseFixture();
    const storage = createDexieStorage(fixture.asGuestProfileDB());

    await storage.clearAll();

    expect(fixture.db.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.db.transaction).toHaveBeenCalledWith('rw', fixture.tables, expect.any(Function));
  });

  it('clears every table inside the transaction callback', async () => {
    const fixture = createDatabaseFixture();
    const events: string[] = [];
    let transactionActive = false;

    fixture.db.transaction.mockImplementation(async (_mode, _tables, scope) => {
      transactionActive = true;
      events.push('transaction');

      try {
        await scope();
      } finally {
        transactionActive = false;
      }
    });

    const namedTables: readonly (readonly [string, TableStub])[] = [
      ['ratings', fixture.db.ratings],
      ['watched', fixture.db.watched],
      ['watchlist', fixture.db.watchlist],
      ['cooldowns', fixture.db.cooldowns],
      ['history', fixture.db.history],
    ];

    for (const [name, table] of namedTables) {
      table.clear.mockImplementation(async () => {
        events.push(transactionActive ? `clear:${name}` : `outside:${name}`);
      });
    }

    await createDexieStorage(fixture.asGuestProfileDB()).clearAll();

    expect(events).toEqual([
      'transaction',
      'clear:ratings',
      'clear:watched',
      'clear:watchlist',
      'clear:cooldowns',
      'clear:history',
    ]);

    for (const table of fixture.tables) {
      expect(table.clear).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects when a table clear fails and stops before clearing the rest', async () => {
    const fixture = createDatabaseFixture();
    fixture.db.ratings.clear.mockRejectedValue(new Error('clear failed'));

    const storage = createDexieStorage(fixture.asGuestProfileDB());

    await expect(storage.clearAll()).rejects.toThrow('clear failed');
    expect(fixture.db.watched.clear).not.toHaveBeenCalled();
    expect(fixture.db.history.clear).not.toHaveBeenCalled();
  });
});
