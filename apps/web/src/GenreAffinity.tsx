import { useMemo } from 'react';
import type { TasteGraph } from './tasteGraph';

export interface GenreAffinityProps {
  graph: TasteGraph;
  loading: boolean;
}

const AFFINITY_LIMIT = 2.5;

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'film' : 'films'}`;
}

function formatMean(mean: number): string {
  return mean.toFixed(1);
}

function barWidth(affinity: number): string {
  const percentage = Math.min(100, Math.round((Math.abs(affinity) / AFFINITY_LIMIT) * 100));

  return `${percentage}%`;
}

function formatAffinity(affinity: number): string {
  const rounded = Math.abs(affinity) < 0.05 ? 0 : affinity;

  if (rounded > 0) {
    return `+${rounded.toFixed(1)}`;
  }

  return rounded < 0 ? `−${Math.abs(rounded).toFixed(1)}` : '0.0';
}

export function GenreAffinity({ graph, loading }: GenreAffinityProps) {
  const sorted = useMemo(
    () =>
      [...graph.genres].sort(
        (left, right) =>
          right.affinity - left.affinity ||
          right.count - left.count ||
          compareNames(left.genre, right.genre),
      ),
    [graph.genres],
  );

  return (
    <section className="dashboard__panel" aria-labelledby="dashboard-affinity-heading">
      <h3 className="dashboard__section-heading" id="dashboard-affinity-heading">
        Genre affinity
      </h3>

      {loading ? (
        <p className="genre-affinity__status">Reading your genres…</p>
      ) : sorted.length === 0 ? (
        <p className="dashboard__empty">Rate a few films and their genres will line up here.</p>
      ) : (
        <>
          <p className="genre-affinity__scale">−2.5 · neutral · +2.5</p>

          <ol className="genre-affinity">
            {sorted.map((genre) => {
              const width = barWidth(genre.affinity);

              return (
                <li className="genre-affinity__row" key={genre.genre}>
                  <span className="genre-affinity__film">
                    <span className="genre-affinity__genre">{genre.genre}</span>
                    <span className="genre-affinity__values">
                      {`${countLabel(genre.count)} · ${formatMean(genre.meanRating)} avg`}
                    </span>
                  </span>
                  <span className="genre-affinity__track" aria-hidden="true">
                    <span className="genre-affinity__half genre-affinity__half--negative">
                      {genre.affinity < 0 && (
                        <span
                          className="genre-affinity__bar genre-affinity__bar--negative"
                          style={{ width }}
                        />
                      )}
                    </span>
                    <span className="genre-affinity__half genre-affinity__half--positive">
                      {genre.affinity >= 0 && (
                        <span
                          className="genre-affinity__bar genre-affinity__bar--positive"
                          style={{ width }}
                        />
                      )}
                    </span>
                  </span>
                  <span className="genre-affinity__affinity">{formatAffinity(genre.affinity)}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
