import { describe, expect, it } from 'vitest';
import { buildTasteGraph } from './tasteGraph';

function film(movieId: number, rating: number, genres: readonly string[]) {
  return { movieId, rating, genres };
}

describe('buildTasteGraph', () => {
  it('counts films and means per genre, with affinity measured against 2.5', () => {
    const graph = buildTasteGraph([
      film(1, 4.5, ['Drama', 'Science Fiction']),
      film(2, 3.5, ['Drama']),
      film(3, 2, ['Horror']),
    ]);

    expect(graph.genres).toEqual([
      { genre: 'Drama', count: 2, meanRating: 4, affinity: 1.5 },
      { genre: 'Horror', count: 1, meanRating: 2, affinity: -0.5 },
      { genre: 'Science Fiction', count: 1, meanRating: 4.5, affinity: 2 },
    ]);
    expect(graph.allGenres).toEqual(graph.genres);
    expect(graph.edges).toEqual([{ a: 'Drama', b: 'Science Fiction', count: 1 }]);
    expect(graph.filmCount).toBe(3);
    expect(graph.meanRating).toBeCloseTo(10 / 3);
    expect(graph.totalGenres).toBe(3);
  });

  it('counts unordered co-occurring pairs once per film and dedupes duplicate genres', () => {
    const graph = buildTasteGraph([
      film(1, 4, ['Drama', 'Drama', 'Comedy']),
      film(2, 3, ['Comedy', 'Drama']),
      film(3, 5, ['Drama', 'Comedy', 'Horror']),
    ]);

    expect(graph.genres).toEqual([
      { genre: 'Comedy', count: 3, meanRating: 4, affinity: 1.5 },
      { genre: 'Drama', count: 3, meanRating: 4, affinity: 1.5 },
      { genre: 'Horror', count: 1, meanRating: 5, affinity: 2.5 },
    ]);
    expect(graph.allGenres).toEqual(graph.genres);
    expect(graph.edges).toEqual([
      { a: 'Comedy', b: 'Drama', count: 3 },
      { a: 'Comedy', b: 'Horror', count: 1 },
      { a: 'Drama', b: 'Horror', count: 1 },
    ]);
  });

  it('caps the genre set and edges, reporting the uncapped genre count', () => {
    const graph = buildTasteGraph([film(1, 4, ['Drama', 'Comedy', 'Horror', 'Action'])], {
      maxGenres: 3,
      maxEdges: 2,
    });

    expect(graph.genres.map((genre) => genre.genre)).toEqual(['Action', 'Comedy', 'Drama']);
    expect(graph.allGenres.map((genre) => genre.genre)).toEqual([
      'Action',
      'Comedy',
      'Drama',
      'Horror',
    ]);
    expect(graph.edges).toEqual([
      { a: 'Action', b: 'Comedy', count: 1 },
      { a: 'Action', b: 'Drama', count: 1 },
    ]);
    expect(graph.totalGenres).toBe(4);
  });

  it('breaks genre ties by name and keeps every edge among all genres', () => {
    const graph = buildTasteGraph(
      [film(1, 4, ['Zeta', 'Mega', 'Alpha']), film(2, 3, ['Mega', 'Zeta'])],
      { maxGenres: 2 },
    );

    expect(graph.genres.map((genre) => genre.genre)).toEqual(['Mega', 'Zeta']);
    expect(graph.allGenres.map((genre) => genre.genre)).toEqual(['Mega', 'Zeta', 'Alpha']);
    expect(graph.edges).toEqual([
      { a: 'Mega', b: 'Zeta', count: 2 },
      { a: 'Alpha', b: 'Mega', count: 1 },
      { a: 'Alpha', b: 'Zeta', count: 1 },
    ]);
    expect(graph.totalGenres).toBe(3);
  });

  it('keeps the strongest edges among all genres, not only the plotted ones', () => {
    const graph = buildTasteGraph(
      [
        film(1, 4, ['Drama', 'Comedy', 'Horror']),
        film(2, 4, ['Drama', 'Western']),
        film(3, 4, ['Drama', 'Comedy']),
      ],
      { maxGenres: 2, maxEdges: 10 },
    );

    expect(graph.allGenres.map((genre) => genre.genre)).toEqual([
      'Drama',
      'Comedy',
      'Horror',
      'Western',
    ]);
    expect(graph.genres.map((genre) => genre.genre)).toEqual(['Drama', 'Comedy']);
    expect(graph.edges).toEqual([
      { a: 'Comedy', b: 'Drama', count: 2 },
      { a: 'Comedy', b: 'Horror', count: 1 },
      { a: 'Drama', b: 'Horror', count: 1 },
      { a: 'Drama', b: 'Western', count: 1 },
    ]);
  });

  it('returns zeros and empty arrays for an empty input', () => {
    expect(buildTasteGraph([])).toEqual({
      allGenres: [],
      genres: [],
      edges: [],
      filmCount: 0,
      meanRating: 0,
      totalGenres: 0,
    });
  });

  it('counts a duplicated genre once and never makes a self-edge', () => {
    const graph = buildTasteGraph([film(1, 5, ['Drama', 'Drama'])]);

    expect(graph.genres).toEqual([{ genre: 'Drama', count: 1, meanRating: 5, affinity: 2.5 }]);
    expect(graph.allGenres).toEqual(graph.genres);
    expect(graph.edges).toEqual([]);
  });

  it('ignores films without genres for every stat', () => {
    const graph = buildTasteGraph([film(1, 5, []), film(2, 1, [])]);

    expect(graph).toEqual({
      allGenres: [],
      genres: [],
      edges: [],
      filmCount: 0,
      meanRating: 0,
      totalGenres: 0,
    });
  });
});
