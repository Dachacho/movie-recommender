import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MalformedCsvError } from './csv.js';
import {
  prepareSnapshot,
  readCsvRecords,
  selectTopByPopularity,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_LIMIT,
  toSnapshotMovie,
  type QualifiedMovie,
} from './snapshot.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/tmdb-snapshot-sample.csv', import.meta.url));

function sourceOf(text: string, chunkSize?: number): AsyncIterable<Buffer | string> {
  return {
    async *[Symbol.asyncIterator]() {
      if (chunkSize === undefined) {
        yield text;
        return;
      }

      for (let start = 0; start < text.length; start += chunkSize) {
        yield text.slice(start, start + chunkSize);
      }
    },
  };
}

const baseRow = {
  id: '100',
  title: 'Ariel',
  vote_average: '7.1',
  vote_count: '382.0',
  status: 'Released',
  release_date: '1988-10-21',
  runtime: '73.0',
  overview: 'A Finnish man goes to the city to find a job.',
  popularity: '3.378',
  tagline: '',
  genres: 'Drama, Romance, Crime',
  cast: 'Turo Pajala, Susanna Haavisto',
  director: 'Aki Kaurismäki',
  poster_path: '/ojDg0PGvs6R9xYFodRct2kdI6wC.jpg',
  keywords: 'prison|underdog|helsinki, finland',
  imdb_rating: '7.4',
  imdb_votes: '10105.0',
};

const CANDIDATE: QualifiedMovie = {
  id: 1,
  title: 'Candidate',
  releaseYear: 2000,
  overview: 'An overview.',
  tagline: null,
  runtime: 90,
  genres: [],
  keywords: [],
  director: null,
  cast: [],
  posterPath: null,
  popularity: 0,
  voteAverage: null,
  voteCount: null,
  embedding: null,
  embeddingVersion: null,
};

function candidate(id: number, popularity: number): QualifiedMovie {
  return { ...CANDIDATE, id, popularity };
}

describe('readCsvRecords', () => {
  it('handles quoted commas, doubled quotes and multiline fields', async () => {
    const text = 'id,overview\n1,"He said ""hi"", then\nleft."\n2,plain\n';
    const rows: string[][] = [];

    for await (const row of readCsvRecords(sourceOf(text, 3))) {
      rows.push(row);
    }

    expect(rows).toEqual([
      ['id', 'overview'],
      ['1', 'He said "hi", then\nleft.'],
      ['2', 'plain'],
    ]);
  });

  it('handles records split after an escaping quote', async () => {
    const text = 'id,title\n1,"say ""hi"""\n';
    const rows: string[][] = [];

    for await (const row of readCsvRecords(sourceOf(text, 6))) {
      rows.push(row);
    }

    expect(rows).toEqual([
      ['id', 'title'],
      ['1', 'say "hi"'],
    ]);
  });

  it('keeps multibyte characters split across buffer chunks', async () => {
    const bytes = Buffer.from('id,title\n1,"café"\n');
    const chunks = Array.from({ length: bytes.length }, (_, index) =>
      bytes.subarray(index, index + 1),
    );
    const rows: string[][] = [];

    for await (const row of readCsvRecords(
      (async function* () {
        yield* chunks;
      })(),
    )) {
      rows.push(row);
    }

    expect(rows).toEqual([
      ['id', 'title'],
      ['1', 'café'],
    ]);
  });

  it('ignores empty lines and accepts buffers', async () => {
    const rows: string[][] = [];

    for await (const row of readCsvRecords(
      (async function* () {
        yield Buffer.from('id,title\n\n1,Toy Story\n');
      })(),
    )) {
      rows.push(row);
    }

    expect(rows).toEqual([
      ['id', 'title'],
      ['1', 'Toy Story'],
    ]);
  });
});

describe('toSnapshotMovie', () => {
  it('maps a released row with a complete overview and runtime', () => {
    expect(toSnapshotMovie(baseRow)).toEqual({
      id: 100,
      title: 'Ariel',
      releaseYear: 1988,
      overview: 'A Finnish man goes to the city to find a job.',
      tagline: null,
      runtime: 73,
      genres: ['Drama', 'Romance', 'Crime'],
      keywords: ['prison', 'underdog', 'helsinki, finland'],
      director: 'Aki Kaurismäki',
      cast: ['Turo Pajala', 'Susanna Haavisto'],
      posterPath: '/ojDg0PGvs6R9xYFodRct2kdI6wC.jpg',
      popularity: 3.378,
      voteAverage: 7.1,
      voteCount: 382,
      imdbRating: 7.4,
      imdbVotes: 10105,
      embedding: null,
      embeddingVersion: null,
    });
  });

  it('keeps blank or unparseable IMDb values as null', () => {
    expect(toSnapshotMovie({ ...baseRow, imdb_rating: '', imdb_votes: '' })).toMatchObject({
      imdbRating: null,
      imdbVotes: null,
    });
    expect(toSnapshotMovie({ ...baseRow, imdb_rating: 'null', imdb_votes: 'null' })).toMatchObject({
      imdbRating: null,
      imdbVotes: null,
    });
    expect(
      toSnapshotMovie({ ...baseRow, imdb_rating: 'not-a-number', imdb_votes: 'lots' }),
    ).toMatchObject({ imdbRating: null, imdbVotes: null });
    expect(
      toSnapshotMovie({ ...baseRow, imdb_rating: 'Infinity', imdb_votes: 'Infinity' }),
    ).toMatchObject({ imdbRating: null, imdbVotes: null });
  });

  it('clamps IMDb ratings to the 0-10 range', () => {
    expect(toSnapshotMovie({ ...baseRow, imdb_rating: '-1.5' })).toMatchObject({
      imdbRating: 0,
    });
    expect(toSnapshotMovie({ ...baseRow, imdb_rating: '10.5' })).toMatchObject({
      imdbRating: 10,
    });
    expect(toSnapshotMovie({ ...baseRow, imdb_rating: '8.7' })).toMatchObject({
      imdbRating: 8.7,
    });
  });

  it('rounds IMDb votes to integers and rejects out-of-range counts', () => {
    expect(toSnapshotMovie({ ...baseRow, imdb_votes: '1234.6' })).toMatchObject({
      imdbVotes: 1235,
    });
    expect(toSnapshotMovie({ ...baseRow, imdb_votes: '0.0' })).toMatchObject({ imdbVotes: 0 });
    expect(toSnapshotMovie({ ...baseRow, imdb_votes: '-1' })).toMatchObject({ imdbVotes: null });
    expect(toSnapshotMovie({ ...baseRow, imdb_votes: '2147483648' })).toMatchObject({
      imdbVotes: null,
    });
  });

  it('rejects rows without a positive integer id', () => {
    expect(toSnapshotMovie({ ...baseRow, id: '1997-08-20' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, id: '0' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, id: '-4' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, id: '2147483648' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, id: ' 100 ' })).toMatchObject({ id: 100 });
  });

  it('rejects rows that are not released, lack an overview or a runtime', () => {
    expect(toSnapshotMovie({ ...baseRow, status: 'Rumored' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, status: '' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, overview: '  ' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, runtime: '0.0' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, runtime: '' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, runtime: 'soon' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, runtime: '1e12' })).toBeNull();
  });

  it('rejects rows whose popularity cannot be ranked', () => {
    expect(toSnapshotMovie({ ...baseRow, popularity: '' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, popularity: 'not-a-number' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, popularity: 'Infinity' })).toBeNull();
  });

  it('keeps runtimes that round to at least one minute', () => {
    expect(toSnapshotMovie({ ...baseRow, runtime: '0.6' })).toMatchObject({ runtime: 1 });
    expect(toSnapshotMovie({ ...baseRow, runtime: '0.5' })).toMatchObject({ runtime: 1 });
  });

  it('rejects runtimes that round to zero', () => {
    expect(toSnapshotMovie({ ...baseRow, runtime: '0.4' })).toBeNull();
    expect(toSnapshotMovie({ ...baseRow, runtime: '0.4999' })).toBeNull();
  });

  it('keeps unparseable dates and empty optional fields as null', () => {
    expect(toSnapshotMovie({ ...baseRow, release_date: '' })).toMatchObject({ releaseYear: null });
    expect(toSnapshotMovie({ ...baseRow, release_date: '1988' })).toMatchObject({
      releaseYear: 1988,
    });
    expect(toSnapshotMovie({ ...baseRow, release_date: 'dd-mm-yyyy' })).toMatchObject({
      releaseYear: null,
    });
    expect(
      toSnapshotMovie({ ...baseRow, tagline: '  ', director: '', poster_path: '' }),
    ).toMatchObject({ tagline: null, director: null, posterPath: null });
  });

  it('only keeps relative poster paths', () => {
    expect(
      toSnapshotMovie({ ...baseRow, poster_path: 'https://image.tmdb.org/poster.jpg' }),
    ).toMatchObject({ posterPath: null });
  });

  it('splits lists, trims entries and drops empties and duplicates', () => {
    expect(
      toSnapshotMovie({
        ...baseRow,
        genres: 'Drama, ,Crime, Drama,',
        keywords: 'a||b|a| ',
        cast: 'X, ,Y',
      }),
    ).toMatchObject({ genres: ['Drama', 'Crime'], keywords: ['a', 'b'], cast: ['X', 'Y'] });
  });

  it('bounds long text and list fields', () => {
    expect(toSnapshotMovie({ ...baseRow, title: 't'.repeat(600) })).toMatchObject({
      title: 't'.repeat(512),
    });
    expect(toSnapshotMovie({ ...baseRow, overview: 'o'.repeat(5000) })).toMatchObject({
      overview: 'o'.repeat(4000),
    });
    expect(toSnapshotMovie({ ...baseRow, tagline: 'g'.repeat(600) })).toMatchObject({
      tagline: 'g'.repeat(500),
    });
    expect(toSnapshotMovie({ ...baseRow, director: 'd'.repeat(400) })).toMatchObject({
      director: 'd'.repeat(300),
    });
    expect(
      toSnapshotMovie({
        ...baseRow,
        genres: Array.from({ length: 25 }, (_, i) => `g${i}`).join(','),
      }),
    ).toMatchObject({ genres: Array.from({ length: 20 }, (_, i) => `g${i}`) });
    expect(
      toSnapshotMovie({
        ...baseRow,
        keywords: Array.from({ length: 60 }, (_, i) => `k${i}`).join('|'),
      }),
    ).toMatchObject({ keywords: Array.from({ length: 50 }, (_, i) => `k${i}`) });
    expect(
      toSnapshotMovie({
        ...baseRow,
        cast: Array.from({ length: 12 }, (_, i) => `c${i}`).join(','),
      }),
    ).toMatchObject({ cast: Array.from({ length: 8 }, (_, i) => `c${i}`) });
    expect(toSnapshotMovie({ ...baseRow, cast: 'x'.repeat(300) })).toMatchObject({
      cast: ['x'.repeat(200)],
    });
  });
});

describe('selectTopByPopularity', () => {
  it('keeps the most popular rows and orders popularity descending', () => {
    const selected = selectTopByPopularity(
      [candidate(1, 1), candidate(2, 50), candidate(3, 10), candidate(4, 25)],
      2,
    );

    expect(selected.map((movie) => movie.id)).toEqual([2, 4]);
  });

  it('breaks popularity ties by id ascending', () => {
    const selected = selectTopByPopularity(
      [candidate(9, 10), candidate(3, 10), candidate(5, 10), candidate(7, 5)],
      3,
    );

    expect(selected.map((movie) => movie.id)).toEqual([3, 5, 9]);
  });

  it('returns everything when the limit exceeds the input', () => {
    expect(selectTopByPopularity([candidate(2, 1), candidate(1, 2)], 10)).toHaveLength(2);
  });

  it('returns an empty list for empty input', () => {
    expect(selectTopByPopularity([], 3)).toEqual([]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => selectTopByPopularity([], 0)).toThrow();
  });
});

describe('SNAPSHOT_LIMIT', () => {
  it('fixes the curated catalog at 40,000 movies', () => {
    expect(SNAPSHOT_LIMIT).toBe(40_000);
  });
});

describe('prepareSnapshot', () => {
  it('curates the fixture snapshot', async () => {
    const text = await readFile(FIXTURE_PATH, 'utf8');
    const { movies, stats } = await prepareSnapshot(sourceOf(text), 3);

    expect(stats).toEqual({
      rows: 11,
      invalid: 5,
      duplicates: 1,
      qualified: 5,
      selected: 3,
    });
    expect(movies.map((movie) => movie.id)).toEqual([50, 75, 100]);
    expect(movies[2]).toMatchObject({
      title: 'Ariel',
      releaseYear: 1988,
      runtime: 73,
      genres: ['Drama', 'Romance', 'Crime'],
      keywords: ['prison', 'underdog'],
      director: 'Aki Kaurismäki',
      posterPath: '/a.jpg',
      popularity: 10.5,
      imdbRating: 7.4,
      imdbVotes: 10105,
    });
  });

  it('reads the same rows when chunks split records and escaping quotes', async () => {
    const text = await readFile(FIXTURE_PATH, 'utf8');
    const whole = await prepareSnapshot(sourceOf(text), 5);
    const chunked = await prepareSnapshot(sourceOf(text, 7), 5);

    expect(chunked).toEqual(whole);
  });

  it('reads a real file stream', async () => {
    const { movies } = await prepareSnapshot(createReadStream(FIXTURE_PATH), 2);

    expect(movies.map((movie) => movie.id)).toEqual([50, 75]);
  });

  it('reports a selection smaller than the fixed catalog size', async () => {
    const text = await readFile(FIXTURE_PATH, 'utf8');
    const { movies, stats } = await prepareSnapshot(sourceOf(text), SNAPSHOT_LIMIT);

    expect(stats.selected).toBe(5);
    expect(movies).toHaveLength(5);
  });

  it('rejects a CSV without the required columns', async () => {
    await expect(prepareSnapshot(sourceOf('id,title\n1,Toy Story\n'))).rejects.toThrow(
      'CSV is missing required columns',
    );
  });

  it('rejects an empty CSV', async () => {
    await expect(prepareSnapshot(sourceOf(''))).rejects.toThrow('CSV is empty');
  });

  it('rejects an unterminated quoted field instead of importing it', async () => {
    const text = `${SNAPSHOT_COLUMNS.join(',')}\n100,"Unclosed`;

    await expect(prepareSnapshot(sourceOf(text))).rejects.toThrow(MalformedCsvError);
  });

  it('rejects a negative limit', async () => {
    await expect(prepareSnapshot(sourceOf(''), -1)).rejects.toThrow();
  });
});
