import { describe, expect, it } from 'vitest';
import {
  buildEmbeddingText,
  dedupeById,
  parseCredits,
  parseNamedList,
  toNewMovie,
} from './parse.js';

const baseRow = {
  adult: 'False',
  id: '862',
  title: 'Toy Story',
  overview: 'A cowboy doll is profoundly threatened by a new spaceman figure.',
  release_date: '1995-10-30',
  runtime: '81.0',
  genres: "[{'id': 16, 'name': 'Animation'}, {'id': 35, 'name': 'Comedy'}]",
  poster_path: '/rhIRbceoE9lR4veEXuwCC2wARtG.jpg',
  popularity: '21.946943',
  vote_average: '7.7',
  vote_count: '5415',
  status: 'Released',
  tagline: '',
};

describe('parseNamedList', () => {
  it('reads names from a python-literal list of dicts', () => {
    expect(
      parseNamedList("[{'id': 16, 'name': 'Animation'}, {'id': 35, 'name': 'Comedy'}]"),
    ).toEqual(['Animation', 'Comedy']);
  });

  it('unescapes apostrophes', () => {
    expect(parseNamedList("[{'id': 1, 'name': 'kids\\' stuff'}]")).toEqual(["kids' stuff"]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseNamedList('')).toEqual([]);
    expect(parseNamedList('[]')).toEqual([]);
  });
});

describe('parseCredits', () => {
  const crew = `[{'department': 'Directing', 'job': 'Director', 'name': 'John Lasseter'},
    {'department': 'Writing', 'job': 'Screenplay', 'name': 'Joss Whedon'}]`;
  const cast = `[{'name': 'Tom Hanks', 'order': 1}, {'name': 'Tim Allen', 'order': 0},
    {'name': 'Don Rickles', 'order': 2}]`;

  it('takes the first director and the lowest-ordered cast', () => {
    expect(parseCredits(cast, crew, 2)).toEqual({
      director: 'John Lasseter',
      cast: ['Tim Allen', 'Tom Hanks'],
    });
  });

  it('returns null director when no director credit exists', () => {
    expect(parseCredits('[]', "[{'job': 'Writer', 'name': 'Someone'}]", 4)).toEqual({
      director: null,
      cast: [],
    });
  });
});

describe('toNewMovie', () => {
  it('maps a clean row', () => {
    const movie = toNewMovie(baseRow, { director: 'John Lasseter', cast: ['Tom Hanks'] }, [
      'jealousy',
    ]);

    expect(movie).toMatchObject({
      id: 862,
      title: 'Toy Story',
      releaseYear: 1995,
      runtime: 81,
      tagline: null,
      genres: ['Animation', 'Comedy'],
      keywords: ['jealousy'],
      director: 'John Lasseter',
      cast: ['Tom Hanks'],
      posterPath: '/rhIRbceoE9lR4veEXuwCC2wARtG.jpg',
      popularity: 21.946943,
      voteAverage: 7.7,
      voteCount: 5415,
      embedding: null,
    });
  });

  it('rejects rows whose id is not an integer', () => {
    expect(toNewMovie({ ...baseRow, id: '1997-08-20' }, undefined, [])).toBeNull();
  });

  it('rejects unreleased, adult and empty rows', () => {
    expect(toNewMovie({ ...baseRow, status: 'Rumored' }, undefined, [])).toBeNull();
    expect(toNewMovie({ ...baseRow, adult: 'True' }, undefined, [])).toBeNull();
    expect(toNewMovie({ ...baseRow, overview: '  ' }, undefined, [])).toBeNull();
  });

  it('keeps a row with keywords but no overview', () => {
    expect(toNewMovie({ ...baseRow, overview: '' }, undefined, ['space'])).not.toBeNull();
  });

  it('treats zero or invalid runtime and dates as null', () => {
    const movie = toNewMovie({ ...baseRow, runtime: '0.0', release_date: '' }, undefined, []);

    expect(movie).toMatchObject({ runtime: null, releaseYear: null });
  });

  it('only keeps relative poster paths', () => {
    expect(
      toNewMovie({ ...baseRow, poster_path: 'https://image.tmdb.org/x.jpg' }, undefined, []),
    ).toMatchObject({
      posterPath: null,
    });
  });
});

describe('dedupeById', () => {
  it('keeps the row with the highest vote count', () => {
    const rows = [
      { id: 1, voteCount: 10 },
      { id: 1, voteCount: 42 },
      { id: 2, voteCount: 5 },
    ];

    expect(dedupeById(rows).map((row) => row.voteCount)).toEqual([42, 5]);
  });
});

describe('buildEmbeddingText', () => {
  it('joins the available fields', () => {
    const text = buildEmbeddingText({
      title: 'Toy Story',
      overview: 'A cowboy doll feels threatened.',
      tagline: 'The toys are back.',
      genres: ['Animation'],
      keywords: ['friendship'],
    });

    expect(text).toBe(
      'Toy Story. A cowboy doll feels threatened. The toys are back. Animation. friendship',
    );
  });

  it('returns null when there is nothing to embed', () => {
    expect(
      buildEmbeddingText({
        title: 'Empty',
        overview: null,
        tagline: null,
        genres: [],
        keywords: [],
      }),
    ).toBeNull();
  });
});
