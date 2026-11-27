import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TasteConstellation } from './TasteConstellation';
import { buildTasteGraph } from './tasteGraph';

afterEach(cleanup);

const GRAPH = buildTasteGraph([
  { movieId: 1, rating: 5, genres: ['Drama', 'Science Fiction'] },
  { movieId: 2, rating: 4, genres: ['Drama', 'Crime'] },
  { movieId: 3, rating: 2, genres: ['Drama', 'Comedy'] },
]);

function renderConstellation(): ReturnType<typeof render> {
  return render(<TasteConstellation graph={GRAPH} loading={false} ratedCount={3} />);
}

function nodeAt(container: HTMLElement, genre: string): Element {
  const index = GRAPH.genres.findIndex((item) => item.genre === genre);
  const hit = container.querySelectorAll('.taste-node__hit')[index];

  if (hit === undefined) {
    throw new Error(`No node for ${genre}`);
  }

  return hit;
}

describe('TasteConstellation', () => {
  it('shows a genre readout and dims unrelated nodes and edges on tap', () => {
    const { container } = renderConstellation();
    const scienceFiction = nodeAt(container, 'Science Fiction');

    fireEvent.click(scienceFiction);

    expect(container.querySelector('.taste-constellation__readout-title')?.textContent).toBe(
      'Science Fiction',
    );
    expect(
      [...container.querySelectorAll('.taste-constellation__readout-line')].map(
        (line) => line.textContent,
      ),
    ).toEqual(['1 film', '5.0 avg']);
    expect(
      [...container.querySelectorAll('.taste-node__hit')].map((hit) => hit.getAttribute('r')),
    ).toEqual(GRAPH.genres.map(() => '36'));
    expect(container.querySelectorAll('.taste-node-group--dim')).toHaveLength(
      GRAPH.genres.length - 1,
    );
    expect(container.querySelectorAll('.taste-edge--active')).toHaveLength(1);
    expect(container.querySelectorAll('.taste-edge--dim')).toHaveLength(GRAPH.edges.length - 1);

    fireEvent.click(scienceFiction);

    expect(container.querySelector('.taste-constellation__readout-title')?.textContent).toBe(
      'Your taste',
    );
    expect(container.querySelectorAll('.taste-node-group--dim')).toHaveLength(0);
    expect(container.querySelectorAll('.taste-edge--dim')).toHaveLength(0);
  });

  it('shows a no-pairs line when no genres co-occur', () => {
    const graph = buildTasteGraph([
      { movieId: 1, rating: 4, genres: ['Drama'] },
      { movieId: 2, rating: 4, genres: ['Comedy'] },
      { movieId: 3, rating: 4, genres: ['Crime'] },
    ]);
    const { getByText, queryByRole } = render(
      <TasteConstellation graph={graph} loading={false} ratedCount={3} />,
    );

    fireEvent.click(getByText('Read as a table'));

    expect(getByText('No repeated genre pairs yet.')).toBeTruthy();
    expect(queryByRole('table', { name: 'Co-occurring genres' })).toBeNull();
  });
});
